import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { getWorkoutApprovalFingerprint } from "./weekPlanHelpers";
import { WEEK_PLAN_DELETION_IN_PROGRESS_ERROR } from "./weekPlanDeletionShared";

const resultValidator = v.union(
  v.object({ status: v.literal("claimed") }),
  v.object({ status: v.literal("canonical"), workoutPlanId: v.id("workoutPlans") }),
  v.object({ status: v.literal("conflict"), error: v.string() }),
);

/** Atomically reserve one linked draft before approval can issue a Tonal POST. */
export const claimDraftForWeekPush = internalMutation({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    dayIndex: v.number(),
    expectedWorkoutPlanId: v.id("workoutPlans"),
    expectedDraftFingerprint: v.string(),
  },
  returns: resultValidator,
  handler: async (ctx, args) => {
    const conflict = (error: string) => ({ status: "conflict" as const, error });
    if (args.dayIndex < 0 || args.dayIndex > 6) return conflict("Invalid week-plan day");
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan || plan.userId !== args.userId) {
      return conflict("Week plan not found or access denied");
    }
    if (plan.deletionReservation) return conflict(WEEK_PLAN_DELETION_IN_PROGRESS_ERROR);

    const currentWorkoutPlanId = plan.days[args.dayIndex]?.workoutPlanId;
    if (currentWorkoutPlanId !== args.expectedWorkoutPlanId) {
      if (!currentWorkoutPlanId) return conflict("The week-plan day no longer has a workout");
      const canonical = await ctx.db.get(currentWorkoutPlanId);
      if (
        !canonical ||
        canonical.userId !== args.userId ||
        canonical.status !== "pushed" ||
        canonical.weekPlanDeletionReservation
      ) {
        return conflict("The linked workout changed without a canonical pushed plan");
      }
      return { status: "canonical" as const, workoutPlanId: canonical._id };
    }

    const draft = await ctx.db.get(args.expectedWorkoutPlanId);
    if (!draft || draft.userId !== args.userId) {
      return conflict("The linked draft is missing or no longer editable");
    }
    if (draft.weekPlanDeletionReservation) return conflict(WEEK_PLAN_DELETION_IN_PROGRESS_ERROR);
    if (draft.status === "pushed" && draft.tonalWorkoutId) {
      return { status: "canonical" as const, workoutPlanId: draft._id };
    }
    if (draft.status !== "draft") {
      return conflict("Approval is already in progress. Retry to reconcile this day safely.");
    }
    if (getWorkoutApprovalFingerprint(draft) !== args.expectedDraftFingerprint) {
      return conflict(
        "The draft changed while approval was in progress. Retry approval to push the updated workout.",
      );
    }
    await ctx.db.patch(draft._id, { status: "pushing" as const });
    return { status: "claimed" as const };
  },
});
