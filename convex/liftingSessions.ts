import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx, query, type QueryCtx } from "./_generated/server";
import { getEffectiveUserId } from "./lib/auth";
import {
  DEFAULT_LIST_LIMIT,
  liftingSessionDetailValidator,
  liftingSessionInputValidator,
  type LiftingSessionSummary,
  liftingSessionSummaryValidator,
  type LiftingSetView,
  MAX_EXERCISES,
  MAX_LIST_LIMIT,
  MAX_TOTAL_SETS,
  type NormalizedExercise,
  normalizeSession,
  toLiftingSessionSummary,
} from "./liftingSessionContract";
import { rateLimiter } from "./rateLimits";

async function readDetail(ctx: QueryCtx | MutationCtx, row: Doc<"liftingSessions">) {
  const [exerciseRows, setRows] = await Promise.all([
    ctx.db
      .query("liftingExercises")
      .withIndex("by_sessionId_and_order", (q) => q.eq("sessionId", row._id))
      .take(MAX_EXERCISES),
    ctx.db
      .query("liftingSets")
      .withIndex("by_sessionId_and_exerciseOrder_and_order", (q) => q.eq("sessionId", row._id))
      .take(MAX_TOTAL_SETS),
  ]);
  const setsByExercise = new Map<Id<"liftingExercises">, LiftingSetView[]>();
  for (const set of setRows) {
    const values = setsByExercise.get(set.exerciseId) ?? [];
    values.push({
      setId: set._id,
      order: set.order,
      kind: set.kind,
      reps: set.reps,
      weightLbs: set.weightLbs ?? null,
      rpe: set.rpe ?? null,
    });
    setsByExercise.set(set.exerciseId, values);
  }
  return {
    ...toLiftingSessionSummary(row),
    exercises: exerciseRows.map((exercise) => ({
      exerciseId: exercise._id,
      order: exercise.order,
      name: exercise.name,
      setCount: exercise.setCount,
      totalReps: exercise.totalReps,
      totalVolumeLbs: exercise.totalVolumeLbs,
      sets: setsByExercise.get(exercise._id) ?? [],
    })),
  };
}

async function insertChildren(
  ctx: MutationCtx,
  userId: Id<"users">,
  sessionId: Id<"liftingSessions">,
  exercises: readonly NormalizedExercise[],
): Promise<void> {
  for (const [exerciseOrder, exercise] of exercises.entries()) {
    const exerciseId = await ctx.db.insert("liftingExercises", {
      userId,
      sessionId,
      order: exerciseOrder,
      name: exercise.name,
      setCount: exercise.setCount,
      totalReps: exercise.totalReps,
      totalVolumeLbs: exercise.totalVolumeLbs,
    });
    for (const [order, set] of exercise.sets.entries()) {
      await ctx.db.insert("liftingSets", {
        userId,
        sessionId,
        exerciseId,
        exerciseOrder,
        order,
        kind: set.kind,
        reps: set.reps,
        ...(set.weightLbs !== undefined ? { weightLbs: set.weightLbs } : {}),
        ...(set.rpe !== undefined ? { rpe: set.rpe } : {}),
      });
    }
  }
}

async function deleteChildren(ctx: MutationCtx, sessionId: Id<"liftingSessions">): Promise<void> {
  const [sets, exercises] = await Promise.all([
    ctx.db
      .query("liftingSets")
      .withIndex("by_sessionId_and_exerciseOrder_and_order", (q) => q.eq("sessionId", sessionId))
      .take(MAX_TOTAL_SETS),
    ctx.db
      .query("liftingExercises")
      .withIndex("by_sessionId_and_order", (q) => q.eq("sessionId", sessionId))
      .take(MAX_EXERCISES),
  ]);
  for (const set of sets) await ctx.db.delete(set._id);
  for (const exercise of exercises) await ctx.db.delete(exercise._id);
}

export const listMine = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(liftingSessionSummaryValidator),
  handler: async (ctx, { limit }): Promise<LiftingSessionSummary[]> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return [];
    const requestedLimit = limit ?? DEFAULT_LIST_LIMIT;
    if (
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > MAX_LIST_LIMIT
    ) {
      throw new Error(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
    }
    const rows = await ctx.db
      .query("liftingSessions")
      .withIndex("by_userId_and_performedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(requestedLimit);
    return rows.map(toLiftingSessionSummary);
  },
});

export const getMine = query({
  args: { sessionId: v.id("liftingSessions") },
  returns: v.union(liftingSessionDetailValidator, v.null()),
  handler: async (ctx, { sessionId }) => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return null;
    const row = await ctx.db.get("liftingSessions", sessionId);
    if (!row || row.userId !== userId) return null;
    return await readDetail(ctx, row);
  },
});

export const saveMine = mutation({
  args: {
    input: v.union(
      v.object({ kind: v.literal("create"), session: liftingSessionInputValidator }),
      v.object({
        kind: v.literal("replace"),
        sessionId: v.id("liftingSessions"),
        session: liftingSessionInputValidator,
      }),
    ),
  },
  returns: liftingSessionSummaryValidator,
  handler: async (ctx, { input }): Promise<LiftingSessionSummary> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await rateLimiter.limit(ctx, "saveLiftingSession", { key: userId, throws: true });
    const normalized = normalizeSession(input.session);
    const now = Date.now();

    if (input.kind === "replace") {
      const existing = await ctx.db.get("liftingSessions", input.sessionId);
      if (!existing || existing.userId !== userId) throw new Error("Lifting session not found");
      await deleteChildren(ctx, existing._id);
      await ctx.db.replace(existing._id, {
        userId,
        source: "manual",
        performedAt: normalized.performedAt,
        calendarDate: normalized.calendarDate,
        title: normalized.title,
        ...(normalized.durationMinutes !== undefined
          ? { durationMinutes: normalized.durationMinutes }
          : {}),
        ...(normalized.notes ? { notes: normalized.notes } : {}),
        exerciseCount: normalized.exerciseCount,
        setCount: normalized.setCount,
        totalReps: normalized.totalReps,
        totalVolumeLbs: normalized.totalVolumeLbs,
        createdAt: existing.createdAt,
        updatedAt: now,
      });
      await insertChildren(ctx, userId, existing._id, normalized.exercises);
      const replaced = await ctx.db.get("liftingSessions", existing._id);
      if (!replaced) throw new Error("Lifting session not found");
      return toLiftingSessionSummary(replaced);
    }

    const sessionId = await ctx.db.insert("liftingSessions", {
      userId,
      source: "manual",
      performedAt: normalized.performedAt,
      calendarDate: normalized.calendarDate,
      title: normalized.title,
      ...(normalized.durationMinutes !== undefined
        ? { durationMinutes: normalized.durationMinutes }
        : {}),
      ...(normalized.notes ? { notes: normalized.notes } : {}),
      exerciseCount: normalized.exerciseCount,
      setCount: normalized.setCount,
      totalReps: normalized.totalReps,
      totalVolumeLbs: normalized.totalVolumeLbs,
      createdAt: now,
      updatedAt: now,
    });
    await insertChildren(ctx, userId, sessionId, normalized.exercises);
    const created = await ctx.db.get("liftingSessions", sessionId);
    if (!created) throw new Error("Lifting session not found");
    return toLiftingSessionSummary(created);
  },
});

export const deleteMine = mutation({
  args: { sessionId: v.id("liftingSessions") },
  returns: v.null(),
  handler: async (ctx, { sessionId }): Promise<null> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await rateLimiter.limit(ctx, "deleteLiftingSession", { key: userId, throws: true });
    const row = await ctx.db.get("liftingSessions", sessionId);
    if (!row || row.userId !== userId) throw new Error("Lifting session not found");
    await deleteChildren(ctx, sessionId);
    await ctx.db.delete(sessionId);
    return null;
  },
});
