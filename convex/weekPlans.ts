/**
 * Week plans: public API.
 * Queries and mutations callable from the frontend. Also re-exports internal
 * functions from weekPlanInternals.ts to keep the `internal.weekPlans.*` path.
 *
 * Related files:
 *   weekPlanHelpers.ts     -- constants, validators, date utils (no DB)
 *   weekPlanActions.ts     -- actions (programWeek, programMyWeek)
 *   weekPlanInternals.ts   -- internal queries/mutations (for agent, crons, actions)
 *   weekPlanEnriched.ts    -- enrichment action (joins with Tonal activity data)
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getEffectiveUserId } from "./lib/auth";
import {
  daySlotValidator,
  dayStatusValidator,
  DEFAULT_DAYS,
  getDraftWorkoutMutationBlocker,
  getWeekStartDateString,
  isValidWeekStartDateString,
  preferredSplitValidator,
} from "./weekPlanHelpers";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  isWeekPlanDeletionReserved,
  isWorkoutReservedForWeekPlanDeletion,
  WEEK_PLAN_DELETION_IN_PROGRESS_ERROR,
} from "./weekPlanDeletionShared";

function getIncomingWorkoutLinkBlocker(
  workout: Doc<"workoutPlans">,
): "scheduled" | "claimed" | "deleting" | null {
  if (isWorkoutReservedForWeekPlanDeletion(workout)) return "deleting";
  if (
    workout.tonalWorkoutSignupId !== undefined ||
    workout.tonalScheduledDate !== undefined ||
    workout.tonalSchedulingReceiptVerifiedAt !== undefined
  ) {
    return "scheduled";
  }
  return workout.tonalSchedulingClaim !== undefined ? "claimed" : null;
}

async function assertWorkoutRelinkAllowed(
  ctx: MutationCtx,
  options: {
    userId: Id<"users">;
    currentWorkoutPlanId: Id<"workoutPlans"> | undefined;
    nextWorkoutPlanId: Id<"workoutPlans"> | undefined;
  },
): Promise<void> {
  const { userId, currentWorkoutPlanId, nextWorkoutPlanId } = options;
  const nextWorkout = nextWorkoutPlanId ? await ctx.db.get(nextWorkoutPlanId) : null;
  if (nextWorkoutPlanId && (!nextWorkout || nextWorkout.userId !== userId)) {
    throw new Error("Workout plan not found or access denied");
  }
  if (currentWorkoutPlanId === nextWorkoutPlanId) return;
  const currentWorkout = currentWorkoutPlanId ? await ctx.db.get(currentWorkoutPlanId) : null;
  const blocker = currentWorkout ? getDraftWorkoutMutationBlocker(currentWorkout) : null;
  if (blocker === "non_draft") {
    throw new Error(
      "Only draft workouts can be relinked. Pushed or completed workouts stay on their Tonal Calendar date.",
    );
  }
  if (blocker === "scheduled") throw new Error("Scheduled workouts cannot be relinked");
  if (blocker === "claimed") throw new Error("Workout scheduling is in progress");
  if (blocker === "deleting") throw new Error(WEEK_PLAN_DELETION_IN_PROGRESS_ERROR);
  const incomingBlocker = nextWorkout ? getIncomingWorkoutLinkBlocker(nextWorkout) : null;
  if (incomingBlocker === "scheduled") throw new Error("Scheduled workouts cannot be linked");
  if (incomingBlocker === "claimed") throw new Error("Workout scheduling is in progress");
  if (incomingBlocker === "deleting") throw new Error(WEEK_PLAN_DELETION_IN_PROGRESS_ERROR);
}

// Re-export for external consumers
export {
  getWeekStartDateString,
  getWeekStartDateStringInTimezone,
  isValidWeekStartDateString,
  preferredSplitValidator,
} from "./weekPlanHelpers";

// Re-export internal functions to preserve internal API paths (internal.weekPlans.*)
export {
  getByUserIdAndWeekStartInternal,
  hasPendingDraftForWeekInternal,
  getWeekPlanDaysWithWorkoutPlanInternal,
  setDayStatusInternal,
  linkWorkoutPlanToDayInternal,
  createForUserInternal,
  batchUpdateDayStatusesInternal,
  createDraftWorkoutInternal,
  replaceDayDraftWorkoutInternal,
  getWeekPlanById,
  deleteDraftWorkout,
  replaceDraftWithPushed,
} from "./weekPlanInternals";
// Lives in weekPlanDeletion (with the Tonal-clearing action) but keeps its
// internal.weekPlans.* path so existing callers are unaffected.
export { deleteWeekPlanInternal } from "./weekPlanDeletion";

/** Get the current week's plan for the authenticated user. */
export const getCurrentWeekPlan = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return null;
    const weekStartDate = getWeekStartDateString(new Date());
    return await ctx.db
      .query("weekPlans")
      .withIndex("by_userId_weekStartDate", (q) =>
        q.eq("userId", userId).eq("weekStartDate", weekStartDate),
      )
      .first();
  },
});

/** Get a week plan by user and week start date (YYYY-MM-DD, Monday). */
export const getByUserIdAndWeekStart = query({
  args: { weekStartDate: v.string() },
  handler: async (ctx, { weekStartDate }) => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return null;
    return await ctx.db
      .query("weekPlans")
      .withIndex("by_userId_weekStartDate", (q) =>
        q.eq("userId", userId).eq("weekStartDate", weekStartDate),
      )
      .first();
  },
});

/** Create a week plan for the authenticated user. */
export const create = mutation({
  args: {
    weekStartDate: v.string(),
    preferredSplit: preferredSplitValidator,
    targetDays: v.number(),
    days: v.optional(v.array(daySlotValidator)),
  },
  handler: async (ctx, args) => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (!isValidWeekStartDateString(args.weekStartDate)) {
      throw new Error(
        "weekStartDate must be YYYY-MM-DD (e.g. 2026-03-10 for Monday of that week).",
      );
    }
    const existing = await ctx.db
      .query("weekPlans")
      .withIndex("by_userId_weekStartDate", (q) =>
        q.eq("userId", userId).eq("weekStartDate", args.weekStartDate),
      )
      .unique();
    if (existing) {
      throw new Error(`Week plan already exists for ${args.weekStartDate}. Use update instead.`);
    }
    const now = Date.now();
    const days: Doc<"weekPlans">["days"] =
      args.days && args.days.length === 7 ? args.days : DEFAULT_DAYS.map((d) => ({ ...d }));
    for (const day of days) {
      await assertWorkoutRelinkAllowed(ctx, {
        userId,
        currentWorkoutPlanId: undefined,
        nextWorkoutPlanId: day.workoutPlanId,
      });
    }
    const weekPlanId = await ctx.db.insert("weekPlans", {
      userId,
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

/** Update an existing week plan. Only provided fields are patched. */
export const update = mutation({
  args: {
    weekPlanId: v.id("weekPlans"),
    preferredSplit: v.optional(preferredSplitValidator),
    targetDays: v.optional(v.number()),
    days: v.optional(v.array(daySlotValidator)),
  },
  handler: async (ctx, args) => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan || plan.userId !== userId) {
      throw new Error("Week plan not found or access denied");
    }
    if (isWeekPlanDeletionReserved(plan)) throw new Error(WEEK_PLAN_DELETION_IN_PROGRESS_ERROR);
    if (args.days !== undefined && args.days.length !== 7) {
      throw new Error("days must have exactly 7 elements (Mon-Sun)");
    }
    if (args.days !== undefined) {
      for (let dayIndex = 0; dayIndex < plan.days.length; dayIndex += 1) {
        const currentDay = plan.days[dayIndex];
        const nextDay = args.days[dayIndex];
        if (
          currentDay?.status === "completed" &&
          (nextDay?.status !== "completed" ||
            nextDay.sessionType !== currentDay.sessionType ||
            nextDay.workoutPlanId !== currentDay.workoutPlanId ||
            nextDay.estimatedDuration !== currentDay.estimatedDuration)
        ) {
          throw new Error("Completed week-plan days cannot be changed");
        }
        await assertWorkoutRelinkAllowed(ctx, {
          userId,
          currentWorkoutPlanId: plan.days[dayIndex]?.workoutPlanId,
          nextWorkoutPlanId: args.days[dayIndex]?.workoutPlanId,
        });
      }
    }
    await ctx.db.patch(args.weekPlanId, {
      updatedAt: Date.now(),
      ...(args.preferredSplit !== undefined && { preferredSplit: args.preferredSplit }),
      ...(args.targetDays !== undefined && { targetDays: args.targetDays }),
      ...(args.days !== undefined && { days: args.days }),
    });
    return args.weekPlanId;
  },
});

/** Link a workout plan to a specific day (0 = Monday, 6 = Sunday). */
export const linkWorkoutPlanToDay = mutation({
  args: {
    weekPlanId: v.id("weekPlans"),
    dayIndex: v.number(),
    workoutPlanId: v.id("workoutPlans"),
    status: v.optional(dayStatusValidator),
    estimatedDuration: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (args.dayIndex < 0 || args.dayIndex > 6) {
      throw new Error("dayIndex must be 0 (Monday) through 6 (Sunday)");
    }
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan || plan.userId !== userId) {
      throw new Error("Week plan not found or access denied");
    }
    if (isWeekPlanDeletionReserved(plan)) throw new Error(WEEK_PLAN_DELETION_IN_PROGRESS_ERROR);
    const days = [...plan.days];
    const slot = { ...days[args.dayIndex] };
    if (
      slot.status === "completed" &&
      (slot.workoutPlanId !== args.workoutPlanId ||
        (args.status !== undefined && args.status !== "completed"))
    ) {
      throw new Error("Completed week-plan days cannot be changed");
    }
    await assertWorkoutRelinkAllowed(ctx, {
      userId,
      currentWorkoutPlanId: slot.workoutPlanId,
      nextWorkoutPlanId: args.workoutPlanId,
    });
    slot.workoutPlanId = args.workoutPlanId;
    if (args.status !== undefined) slot.status = args.status;
    if (args.estimatedDuration !== undefined) slot.estimatedDuration = args.estimatedDuration;
    days[args.dayIndex] = slot;
    await ctx.db.patch(args.weekPlanId, { days, updatedAt: Date.now() });
    return args.weekPlanId;
  },
});

export { programMyWeek, programWeek } from "./weekPlanActions";
