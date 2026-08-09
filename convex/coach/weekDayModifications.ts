import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { getDraftWorkoutMutationBlocker } from "../weekPlanHelpers";
import {
  isWeekPlanDeletionReserved,
  WEEK_PLAN_DELETION_IN_PROGRESS_ERROR,
} from "../weekPlanDeletionShared";

export type SwapDaySlotsResult = { ok: true } | { ok: false; error: string };

const MOVE_NON_DRAFT_ERROR =
  "Only draft workouts can be moved. Pushed or completed workouts stay on their Tonal Calendar date.";

/** Swap two draft day slots without desynchronizing an existing Tonal Calendar signup. */
export const swapDaySlots = internalMutation({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    fromDayIndex: v.number(),
    toDayIndex: v.number(),
  },
  handler: async (
    ctx,
    { userId, weekPlanId, fromDayIndex, toDayIndex },
  ): Promise<SwapDaySlotsResult> => {
    if (fromDayIndex < 0 || fromDayIndex > 6 || toDayIndex < 0 || toDayIndex > 6) {
      throw new Error("Day indices must be 0 (Monday) through 6 (Sunday)");
    }
    if (fromDayIndex === toDayIndex) return { ok: true };

    const plan = await ctx.db.get(weekPlanId);
    if (!plan || plan.userId !== userId) {
      throw new Error("Week plan not found or access denied");
    }
    if (isWeekPlanDeletionReserved(plan)) {
      return { ok: false, error: WEEK_PLAN_DELETION_IN_PROGRESS_ERROR };
    }

    const linkedPlanIds = [
      plan.days[fromDayIndex]?.workoutPlanId,
      plan.days[toDayIndex]?.workoutPlanId,
    ].filter((planId): planId is Id<"workoutPlans"> => planId !== undefined);
    const linkedPlans = await Promise.all(linkedPlanIds.map((planId) => ctx.db.get(planId)));
    if (linkedPlans.some((workoutPlan) => !workoutPlan || workoutPlan.userId !== userId)) {
      return { ok: false, error: "Linked workout not found or access denied" };
    }
    if (
      linkedPlans.some((workoutPlan) => workoutPlan && getDraftWorkoutMutationBlocker(workoutPlan))
    ) {
      return { ok: false, error: MOVE_NON_DRAFT_ERROR };
    }

    const days = [...plan.days];
    const temp = days[fromDayIndex];
    days[fromDayIndex] = days[toDayIndex];
    days[toDayIndex] = temp;

    await ctx.db.patch(weekPlanId, { days, updatedAt: Date.now() });
    return { ok: true };
  },
});
