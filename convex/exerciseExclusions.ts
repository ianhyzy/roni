import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server";
import { getEffectiveUserId, isDeletionInProgress } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";
import { rateLimiter } from "./rateLimits";

export const MAX_EXCLUDED_EXERCISES = 100;
export const MAX_EXCLUSION_BATCH_SIZE = 12;

const exerciseExclusionValidator = v.object({
  movementId: v.string(),
  movementName: v.string(),
  muscleGroups: v.array(v.string()),
  createdAt: v.number(),
});

export type ExerciseExclusion = {
  movementId: string;
  movementName: string;
  muscleGroups: string[];
  createdAt: number;
};

type ExerciseExclusionDoc = Doc<"exerciseExclusions">;

function toExerciseExclusion(doc: ExerciseExclusionDoc): ExerciseExclusion {
  return {
    movementId: doc.movementId,
    movementName: doc.movementName,
    muscleGroups: doc.muscleGroups,
    createdAt: doc.createdAt,
  };
}

async function listByUserId(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<ExerciseExclusion[]> {
  const rows = await ctx.db
    .query("exerciseExclusions")
    .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
    .order("desc")
    .take(MAX_EXCLUDED_EXERCISES);

  return rows.map(toExerciseExclusion);
}

function normalizeMovementIds(rawMovementIds: readonly string[]): string[] {
  if (rawMovementIds.length === 0) throw new Error("At least one movementId is required");
  if (rawMovementIds.length > MAX_EXCLUSION_BATCH_SIZE) {
    throw new Error(`Maximum ${MAX_EXCLUSION_BATCH_SIZE} exercises per call`);
  }

  const movementIds = rawMovementIds.map((movementId) => movementId.trim());
  if (movementIds.some((movementId) => !movementId)) {
    throw new Error("movementId is required");
  }
  return [...new Set(movementIds)];
}

async function requireActiveUser(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  if (await isDeletionInProgress(ctx, userId)) {
    throw new Error("Account deletion in progress");
  }
}

async function getByMovementId(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  movementId: string,
): Promise<ExerciseExclusionDoc | null> {
  return await ctx.db
    .query("exerciseExclusions")
    .withIndex("by_userId_movementId", (q) => q.eq("userId", userId).eq("movementId", movementId))
    .unique();
}

export const listMine = query({
  args: {},
  returns: v.array(exerciseExclusionValidator),
  handler: async (ctx): Promise<ExerciseExclusion[]> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return [];

    return await listByUserId(ctx, userId);
  },
});

async function addExclusions(
  ctx: MutationCtx,
  userId: Id<"users">,
  rawMovementIds: readonly string[],
): Promise<ExerciseExclusion[]> {
  await requireActiveUser(ctx, userId);
  const movementIds = normalizeMovementIds(rawMovementIds);

  const existingRows = await Promise.all(
    movementIds.map(async (movementId) => await getByMovementId(ctx, userId, movementId)),
  );
  const existingByMovementId = new Map(
    existingRows
      .filter((row): row is ExerciseExclusionDoc => row !== null)
      .map((row) => [row.movementId, toExerciseExclusion(row)]),
  );
  const newMovementIds = movementIds.filter((movementId) => !existingByMovementId.has(movementId));
  const movements = await Promise.all(
    newMovementIds.map(async (movementId) => {
      const movement = await ctx.db
        .query("movements")
        .withIndex("by_tonalId", (q) => q.eq("tonalId", movementId))
        .unique();
      if (!movement) throw new Error(`Movement not found: ${movementId}`);
      return movement;
    }),
  );

  const current = await ctx.db
    .query("exerciseExclusions")
    .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
    .take(MAX_EXCLUDED_EXERCISES + 1);
  if (movements.length > 0 && current.length + movements.length > MAX_EXCLUDED_EXERCISES) {
    throw new Error(`Maximum ${MAX_EXCLUDED_EXERCISES} excluded exercises`);
  }

  const createdAt = Date.now();
  for (const movement of movements) {
    const exclusion = {
      userId,
      movementId: movement.tonalId,
      movementName: movement.name,
      muscleGroups: movement.muscleGroups,
      createdAt,
    };
    await ctx.db.insert("exerciseExclusions", exclusion);
    existingByMovementId.set(movement.tonalId, {
      movementId: exclusion.movementId,
      movementName: exclusion.movementName,
      muscleGroups: exclusion.muscleGroups,
      createdAt: exclusion.createdAt,
    });
  }

  return movementIds.map((movementId) => {
    const exclusion = existingByMovementId.get(movementId);
    if (!exclusion) throw new Error(`Movement not found: ${movementId}`);
    return exclusion;
  });
}

async function removeExclusions(
  ctx: MutationCtx,
  userId: Id<"users">,
  rawMovementIds: readonly string[],
): Promise<ExerciseExclusion[]> {
  await requireActiveUser(ctx, userId);
  const movementIds = normalizeMovementIds(rawMovementIds);
  const existingRows = await Promise.all(
    movementIds.map(async (movementId) => await getByMovementId(ctx, userId, movementId)),
  );
  const rowsToRemove = existingRows.filter((row): row is ExerciseExclusionDoc => row !== null);

  for (const row of rowsToRemove) await ctx.db.delete(row._id);
  return rowsToRemove.map(toExerciseExclusion);
}

export const addMine = mutation({
  args: { movementId: v.string() },
  returns: exerciseExclusionValidator,
  handler: async (ctx, args): Promise<ExerciseExclusion> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await rateLimiter.limit(ctx, "addExerciseExclusion", { key: userId, throws: true });

    const [exclusion] = await addExclusions(ctx, userId, [args.movementId]);
    return exclusion;
  },
});

export const removeMine = mutation({
  args: { movementId: v.string() },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args): Promise<{ removed: boolean }> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await rateLimiter.limit(ctx, "removeExerciseExclusion", { key: userId, throws: true });

    const removed = await removeExclusions(ctx, userId, [args.movementId]);
    return { removed: removed.length > 0 };
  },
});

/** Coach-tool entrypoint. Rate limiting happens upstream on the chat turn. */
export const addManyForUser = internalMutation({
  args: { userId: v.id("users"), movementIds: v.array(v.string()) },
  returns: v.array(exerciseExclusionValidator),
  handler: async (ctx, { userId, movementIds }): Promise<ExerciseExclusion[]> => {
    return await addExclusions(ctx, userId, movementIds);
  },
});

/** Coach-tool entrypoint. Rate limiting happens upstream on the chat turn. */
export const removeManyForUser = internalMutation({
  args: { userId: v.id("users"), movementIds: v.array(v.string()) },
  returns: v.array(exerciseExclusionValidator),
  handler: async (ctx, { userId, movementIds }): Promise<ExerciseExclusion[]> => {
    return await removeExclusions(ctx, userId, movementIds);
  },
});

export const getForUser = internalQuery({
  args: { userId: v.id("users") },
  returns: v.array(exerciseExclusionValidator),
  handler: async (ctx, { userId }): Promise<ExerciseExclusion[]> => {
    if (await isDeletionInProgress(ctx, userId)) return [];
    return await listByUserId(ctx, userId);
  },
});
