import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server";
import { getEffectiveUserId } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";
import { rateLimiter } from "./rateLimits";

export const MAX_EXCLUDED_EXERCISES = 100;

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
  handler: async (ctx): Promise<ExerciseExclusion[]> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return [];

    return await listByUserId(ctx, userId);
  },
});

async function addExclusion(
  ctx: MutationCtx,
  userId: Id<"users">,
  rawMovementId: string,
): Promise<ExerciseExclusion> {
  const movementId = rawMovementId.trim();
  if (!movementId) throw new Error("movementId is required");

  const existing = await getByMovementId(ctx, userId, movementId);
  if (existing) return toExerciseExclusion(existing);

  const movement = await ctx.db
    .query("movements")
    .withIndex("by_tonalId", (q) => q.eq("tonalId", movementId))
    .unique();
  if (!movement) throw new Error("Movement not found");

  const current = await ctx.db
    .query("exerciseExclusions")
    .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
    .take(MAX_EXCLUDED_EXERCISES);
  if (current.length >= MAX_EXCLUDED_EXERCISES) {
    throw new Error(`Maximum ${MAX_EXCLUDED_EXERCISES} excluded exercises`);
  }

  const exclusion = {
    userId,
    movementId,
    movementName: movement.name,
    muscleGroups: movement.muscleGroups,
    createdAt: Date.now(),
  };
  await ctx.db.insert("exerciseExclusions", exclusion);

  return {
    movementId: exclusion.movementId,
    movementName: exclusion.movementName,
    muscleGroups: exclusion.muscleGroups,
    createdAt: exclusion.createdAt,
  };
}

async function removeExclusion(
  ctx: MutationCtx,
  userId: Id<"users">,
  rawMovementId: string,
): Promise<{ removed: boolean; movementName?: string }> {
  const movementId = rawMovementId.trim();
  if (!movementId) throw new Error("movementId is required");

  const existing = await getByMovementId(ctx, userId, movementId);
  if (!existing) return { removed: false };

  await ctx.db.delete(existing._id);
  return { removed: true, movementName: existing.movementName };
}

export const addMine = mutation({
  args: { movementId: v.string() },
  handler: async (ctx, args): Promise<ExerciseExclusion> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await rateLimiter.limit(ctx, "addExerciseExclusion", { key: userId, throws: true });

    return await addExclusion(ctx, userId, args.movementId);
  },
});

export const removeMine = mutation({
  args: { movementId: v.string() },
  handler: async (ctx, args): Promise<{ removed: boolean }> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await rateLimiter.limit(ctx, "removeExerciseExclusion", { key: userId, throws: true });

    const { removed } = await removeExclusion(ctx, userId, args.movementId);
    return { removed };
  },
});

/** Coach-tool entrypoint. Rate limiting happens upstream on the chat turn. */
export const addForUser = internalMutation({
  args: { userId: v.id("users"), movementId: v.string() },
  handler: async (ctx, { userId, movementId }): Promise<ExerciseExclusion> => {
    return await addExclusion(ctx, userId, movementId);
  },
});

/** Coach-tool entrypoint. Rate limiting happens upstream on the chat turn. */
export const removeForUser = internalMutation({
  args: { userId: v.id("users"), movementId: v.string() },
  handler: async (
    ctx,
    { userId, movementId },
  ): Promise<{ removed: boolean; movementName?: string }> => {
    return await removeExclusion(ctx, userId, movementId);
  },
});

export const getForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<ExerciseExclusion[]> => {
    return await listByUserId(ctx, userId);
  },
});
