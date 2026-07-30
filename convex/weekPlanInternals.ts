/**
 * Internal mutations and queries for week plan management.
 * Re-exported from weekPlans.ts to preserve the internal API paths.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  daySlotValidator,
  dayStatusValidator,
  DEFAULT_DAYS,
  getDraftWorkoutMutationBlocker,
  getWorkoutApprovalFingerprint,
  isValidWeekStartDateString,
  NON_DRAFT_WORKOUT_EDIT_ERROR,
  preferredSplitValidator,
} from "./weekPlanHelpers";
import { blockInputValidator } from "./validators";
import { WORKOUT_SOURCE } from "./workoutPlans";
import { normalizeBlocksAgainstCatalog } from "./coach/normalizeBlocks";

/** Internal: get week plan by userId and weekStartDate (for cron/check-ins). */
export const getByUserIdAndWeekStartInternal = internalQuery({
  args: { userId: v.id("users"), weekStartDate: v.string() },
  handler: async (ctx, { userId, weekStartDate }) => {
    return await ctx.db
      .query("weekPlans")
      .withIndex("by_userId_weekStartDate", (q) =>
        q.eq("userId", userId).eq("weekStartDate", weekStartDate),
      )
      .first();
  },
});

/** Internal: whether the specified week still contains a linked draft workout. */
export const hasPendingDraftForWeekInternal = internalQuery({
  args: { userId: v.id("users"), weekStartDate: v.string() },
  handler: async (ctx, { userId, weekStartDate }) => {
    const weekPlan = await ctx.db
      .query("weekPlans")
      .withIndex("by_userId_weekStartDate", (q) =>
        q.eq("userId", userId).eq("weekStartDate", weekStartDate),
      )
      .first();
    if (!weekPlan) return false;

    const workoutPlanIds = new Set(
      weekPlan.days.flatMap((day) => (day.workoutPlanId ? [day.workoutPlanId] : [])),
    );
    for (const workoutPlanId of workoutPlanIds) {
      const workoutPlan = await ctx.db.get(workoutPlanId);
      if (workoutPlan?.userId === userId && workoutPlan.status === "draft") return true;
    }
    return false;
  },
});

/** Internal: find week plan day slots that reference the given workout plan. */
export const getWeekPlanDaysWithWorkoutPlanInternal = internalQuery({
  args: { userId: v.id("users"), workoutPlanId: v.id("workoutPlans") },
  handler: async (ctx, { userId, workoutPlanId }) => {
    const plans = await ctx.db
      .query("weekPlans")
      .withIndex("by_userId_weekStartDate", (q) => q.eq("userId", userId))
      .collect();
    const result: { weekPlanId: Id<"weekPlans">; dayIndex: number }[] = [];
    for (const plan of plans) {
      plan.days.forEach((day, dayIndex) => {
        if (day.workoutPlanId === workoutPlanId) {
          result.push({ weekPlanId: plan._id, dayIndex });
        }
      });
    }
    return result;
  },
});

/** Internal: set a single day's status on a week plan. */
export const setDayStatusInternal = internalMutation({
  args: { weekPlanId: v.id("weekPlans"), dayIndex: v.number(), status: dayStatusValidator },
  handler: async (ctx, { weekPlanId, dayIndex, status }) => {
    if (dayIndex < 0 || dayIndex > 6) return;
    const plan = await ctx.db.get(weekPlanId);
    if (!plan || plan.days.length !== 7) return;
    const days = [...plan.days];
    days[dayIndex] = { ...days[dayIndex], status };
    await ctx.db.patch(weekPlanId, { days, updatedAt: Date.now() });
  },
});

/** Internal: link a workout plan to a day (used by programWeek action). */
export const linkWorkoutPlanToDayInternal = internalMutation({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    dayIndex: v.number(),
    workoutPlanId: v.id("workoutPlans"),
    status: v.optional(dayStatusValidator),
    estimatedDuration: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (args.dayIndex < 0 || args.dayIndex > 6) {
      throw new Error("dayIndex must be 0 (Monday) through 6 (Sunday)");
    }
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan || plan.userId !== args.userId) {
      throw new Error("Week plan not found or access denied");
    }
    const workout = await ctx.db.get(args.workoutPlanId);
    if (!workout || workout.userId !== args.userId) {
      throw new Error("Workout plan not found or access denied");
    }
    const days = [...plan.days];
    const slot = { ...days[args.dayIndex] };
    slot.workoutPlanId = args.workoutPlanId;
    if (args.status !== undefined) slot.status = args.status;
    if (args.estimatedDuration !== undefined) slot.estimatedDuration = args.estimatedDuration;
    days[args.dayIndex] = slot;
    await ctx.db.patch(args.weekPlanId, { days, updatedAt: Date.now() });
    return args.weekPlanId;
  },
});

/** Internal: create a week plan for a given user (used by programWeek action). */
export const createForUserInternal = internalMutation({
  args: {
    userId: v.id("users"),
    weekStartDate: v.string(),
    preferredSplit: preferredSplitValidator,
    targetDays: v.number(),
    days: v.optional(v.array(daySlotValidator)),
  },
  handler: async (ctx, args) => {
    if (!isValidWeekStartDateString(args.weekStartDate)) {
      throw new Error(
        "weekStartDate must be YYYY-MM-DD (e.g. 2026-03-10 for Monday of that week).",
      );
    }
    const existing = await ctx.db
      .query("weekPlans")
      .withIndex("by_userId_weekStartDate", (q) =>
        q.eq("userId", args.userId).eq("weekStartDate", args.weekStartDate),
      )
      .unique();
    if (existing) {
      throw new Error(`Week plan already exists for ${args.weekStartDate}. Use update instead.`);
    }
    const now = Date.now();
    const days =
      args.days && args.days.length === 7 ? args.days : DEFAULT_DAYS.map((d) => ({ ...d }));
    const weekPlanId = await ctx.db.insert("weekPlans", {
      userId: args.userId,
      weekStartDate: args.weekStartDate,
      preferredSplit: args.preferredSplit,
      targetDays: args.targetDays,
      days,
      createdAt: now,
      updatedAt: now,
    });
    return weekPlanId;
  },
});

/** Internal: batch-update day statuses on a week plan (used by enriched action to sync cache). */
export const batchUpdateDayStatusesInternal = internalMutation({
  args: {
    weekPlanId: v.id("weekPlans"),
    updates: v.array(
      v.object({
        dayIndex: v.number(),
        status: dayStatusValidator,
      }),
    ),
  },
  handler: async (ctx, { weekPlanId, updates }) => {
    if (updates.length === 0) return;
    const plan = await ctx.db.get(weekPlanId);
    if (!plan || plan.days.length !== 7) return;
    const days = [...plan.days];
    for (const { dayIndex, status } of updates) {
      if (dayIndex < 0 || dayIndex > 6) continue;
      days[dayIndex] = { ...days[dayIndex], status };
    }
    await ctx.db.patch(weekPlanId, { days, updatedAt: Date.now() });
  },
});

/** Internal: create a draft workout plan (no Tonal push). */
export const createDraftWorkoutInternal = internalMutation({
  args: {
    userId: v.id("users"),
    title: v.string(),
    blocks: blockInputValidator,
    estimatedDuration: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const normalizedBlocks = await normalizeBlocksAgainstCatalog(ctx, args.blocks);
    return await ctx.db.insert("workoutPlans", {
      userId: args.userId,
      title: args.title,
      blocks: normalizedBlocks,
      status: "draft",
      source: WORKOUT_SOURCE,
      estimatedDuration: args.estimatedDuration,
      createdAt: Date.now(),
    });
  },
});

type ReplaceDayDraftWorkoutResult =
  { ok: true; workoutPlanId: Id<"workoutPlans"> } | { ok: false; error: string };

/** Atomically replace the exact draft currently linked to a week-plan day. */
export const replaceDayDraftWorkoutInternal = internalMutation({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    dayIndex: v.number(),
    expectedWorkoutPlanId: v.union(v.id("workoutPlans"), v.null()),
    title: v.string(),
    blocks: blockInputValidator,
    estimatedDuration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ReplaceDayDraftWorkoutResult> => {
    if (args.dayIndex < 0 || args.dayIndex > 6) {
      throw new Error("dayIndex must be 0 (Monday) through 6 (Sunday)");
    }
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan || plan.userId !== args.userId) {
      throw new Error("Week plan not found or access denied");
    }

    const currentWorkoutPlanId = plan.days[args.dayIndex]?.workoutPlanId ?? null;
    if (currentWorkoutPlanId !== args.expectedWorkoutPlanId) {
      return {
        ok: false,
        error: "This workout changed while the edit was being prepared. Please retry.",
      };
    }
    if (currentWorkoutPlanId) {
      const currentWorkout = await ctx.db.get(currentWorkoutPlanId);
      if (!currentWorkout || currentWorkout.userId !== args.userId) {
        return { ok: false, error: "Linked workout not found or access denied" };
      }
      if (getDraftWorkoutMutationBlocker(currentWorkout)) {
        return { ok: false, error: NON_DRAFT_WORKOUT_EDIT_ERROR };
      }
    }

    const normalizedBlocks = await normalizeBlocksAgainstCatalog(ctx, args.blocks);
    const workoutPlanId = await ctx.db.insert("workoutPlans", {
      userId: args.userId,
      title: args.title,
      blocks: normalizedBlocks,
      status: "draft",
      source: WORKOUT_SOURCE,
      estimatedDuration: args.estimatedDuration,
      createdAt: Date.now(),
    });
    const days = [...plan.days];
    days[args.dayIndex] = {
      ...days[args.dayIndex],
      workoutPlanId,
      ...(args.estimatedDuration !== undefined
        ? { estimatedDuration: args.estimatedDuration }
        : {}),
    };
    await ctx.db.patch(args.weekPlanId, { days, updatedAt: Date.now() });
    if (currentWorkoutPlanId) await ctx.db.delete(currentWorkoutPlanId);
    return { ok: true, workoutPlanId };
  },
});

/** Internal: delete a week plan and its linked draft workouts. */
export const deleteWeekPlanInternal = internalMutation({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), deleted: v.boolean() }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan) return { ok: true as const, deleted: false };
    if (plan.userId !== args.userId) {
      return { ok: false as const, error: "Week plan access denied" };
    }

    const workoutPlanIds = [
      ...new Set(plan.days.flatMap((day) => (day.workoutPlanId ? [day.workoutPlanId] : []))),
    ];
    for (const workoutPlanId of workoutPlanIds) {
      const workout = await ctx.db.get(workoutPlanId);
      if (!workout) {
        return { ok: false as const, error: "Linked workout not found" };
      }
      if (workout.userId !== args.userId) {
        return { ok: false as const, error: "Linked workout access denied" };
      }
      const blocker = getDraftWorkoutMutationBlocker(workout);
      if (blocker === "non_draft") {
        return { ok: false as const, error: "Only draft week plans can be deleted" };
      }
      if (blocker === "scheduled") {
        return { ok: false as const, error: "Scheduled workouts cannot be deleted" };
      }
      if (blocker === "claimed") {
        return { ok: false as const, error: "Workout scheduling is in progress" };
      }
    }

    for (const workoutPlanId of workoutPlanIds) {
      await ctx.db.delete(workoutPlanId);
    }
    await ctx.db.delete(args.weekPlanId);
    return { ok: true as const, deleted: true };
  },
});

/** Internal: get week plan by ID with ownership check. */
export const getWeekPlanById = internalQuery({
  args: { weekPlanId: v.id("weekPlans"), userId: v.id("users") },
  handler: async (ctx, { weekPlanId, userId }) => {
    const plan = await ctx.db.get(weekPlanId);
    if (!plan || plan.userId !== userId) return null;
    return plan;
  },
});

/** Internal: delete a single draft workout plan. */
export const deleteDraftWorkout = internalMutation({
  args: { workoutPlanId: v.id("workoutPlans") },
  handler: async (ctx, { workoutPlanId }) => {
    const wp = await ctx.db.get(workoutPlanId);
    if (wp && wp.status === "draft") {
      await ctx.db.delete(workoutPlanId);
    }
  },
});

/** Internal: replace a draft workout link with the pushed version. */
export const replaceDraftWithPushed = internalMutation({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    dayIndex: v.number(),
    oldWorkoutPlanId: v.id("workoutPlans"),
    expectedDraftFingerprint: v.string(),
    newWorkoutPlanId: v.id("workoutPlans"),
    estimatedDuration: v.optional(v.number()),
  },
  returns: v.union(
    v.object({ status: v.literal("replaced"), workoutPlanId: v.id("workoutPlans") }),
    v.object({ status: v.literal("canonical"), workoutPlanId: v.id("workoutPlans") }),
    v.object({ status: v.literal("conflict"), error: v.string() }),
  ),
  handler: async (ctx, args) => {
    const conflict = (error: string) => ({ status: "conflict" as const, error });
    if (args.dayIndex < 0 || args.dayIndex > 6) return conflict("Invalid week-plan day");
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan || plan.userId !== args.userId) {
      return conflict("Week plan not found or access denied");
    }
    const replacement = await ctx.db.get(args.newWorkoutPlanId);
    if (!replacement || replacement.userId !== args.userId || replacement.status !== "pushed") {
      return conflict("Replacement workout is not an owned pushed plan");
    }
    const currentWorkoutPlanId = plan.days[args.dayIndex]?.workoutPlanId;
    if (currentWorkoutPlanId !== args.oldWorkoutPlanId) {
      if (!currentWorkoutPlanId) return conflict("The week-plan day no longer has a workout");
      const canonical = await ctx.db.get(currentWorkoutPlanId);
      if (!canonical || canonical.userId !== args.userId || canonical.status !== "pushed") {
        return conflict("The linked workout changed without a canonical pushed plan");
      }
      return { status: "canonical" as const, workoutPlanId: canonical._id };
    }
    const draft = await ctx.db.get(args.oldWorkoutPlanId);
    if (!draft || draft.userId !== args.userId || draft.status !== "draft") {
      return conflict("The linked draft is missing or no longer editable");
    }
    if (getWorkoutApprovalFingerprint(draft) !== args.expectedDraftFingerprint) {
      return conflict(
        "The draft changed while approval was in progress. Retry approval to push the updated workout.",
      );
    }
    const days = [...plan.days];
    days[args.dayIndex] = {
      ...days[args.dayIndex],
      workoutPlanId: args.newWorkoutPlanId,
      ...(args.estimatedDuration != null && { estimatedDuration: args.estimatedDuration }),
    };
    await ctx.db.patch(args.weekPlanId, { days, updatedAt: Date.now() });
    await ctx.db.delete(args.oldWorkoutPlanId);
    return { status: "replaced" as const, workoutPlanId: args.newWorkoutPlanId };
  },
});
