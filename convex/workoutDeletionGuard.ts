import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalQuery } from "./_generated/server";

export const SCHEDULED_WORKOUT_DELETE_ERROR =
  "This workout is linked to or scheduled by a weekly plan and cannot be deleted individually.";

// Bound each transaction and fail closed if an abnormal account exceeds the action's scan ceiling.
const DELETE_PREFLIGHT_PAGE_SIZE = 16;
const DELETE_PREFLIGHT_MAX_PAGES = 100;

export const getDeleteWorkoutPlanState = internalQuery({
  args: { userId: v.id("users"), tonalWorkoutId: v.string() },
  handler: async (ctx, { userId, tonalWorkoutId }) => {
    const plan = await ctx.db
      .query("workoutPlans")
      .withIndex("by_tonalWorkoutId", (q) => q.eq("tonalWorkoutId", tonalWorkoutId))
      .unique();
    if (!plan || plan.userId !== userId) return null;
    const hasSchedulingBlocker =
      plan.tonalWorkoutSignupId !== undefined ||
      plan.tonalScheduledDate !== undefined ||
      plan.tonalSchedulingReceiptVerifiedAt !== undefined ||
      (plan.tonalSchedulingClaim !== undefined &&
        plan.tonalSchedulingClaim.leaseExpiresAt > Date.now());
    return { workoutPlanId: plan._id, hasSchedulingBlocker };
  },
});

export const getDeleteWorkoutLinkPage = internalQuery({
  args: {
    userId: v.id("users"),
    workoutPlanId: v.id("workoutPlans"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { userId, workoutPlanId, paginationOpts }) => {
    const result = await ctx.db
      .query("weekPlans")
      .withIndex("by_userId_weekStartDate", (q) => q.eq("userId", userId))
      .paginate(paginationOpts);
    return {
      isLinked: result.page.some((week) =>
        week.days.some((day) => day.workoutPlanId === workoutPlanId),
      ),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const getDeleteWorkoutBlocker = internalAction({
  args: { userId: v.id("users"), tonalWorkoutId: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const state: { workoutPlanId: Id<"workoutPlans">; hasSchedulingBlocker: boolean } | null =
      await ctx.runQuery(internal.workoutPlans.getDeleteWorkoutPlanState, args);
    if (!state) return null;
    if (state.hasSchedulingBlocker) return SCHEDULED_WORKOUT_DELETE_ERROR;

    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < DELETE_PREFLIGHT_MAX_PAGES; pageIndex += 1) {
      const page: { isLinked: boolean; isDone: boolean; continueCursor: string } =
        await ctx.runQuery(internal.workoutPlans.getDeleteWorkoutLinkPage, {
          userId: args.userId,
          workoutPlanId: state.workoutPlanId,
          paginationOpts: { cursor, numItems: DELETE_PREFLIGHT_PAGE_SIZE },
        });
      if (page.isLinked) return SCHEDULED_WORKOUT_DELETE_ERROR;
      if (page.isDone) return null;
      cursor = page.continueCursor;
    }
    return SCHEDULED_WORKOUT_DELETE_ERROR;
  },
});
