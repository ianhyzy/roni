import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/** Completion is dominant: it cancels pre-call deletion or fences partial side effects. */
export async function fenceDeletionAfterCompletion(
  ctx: MutationCtx,
  plan: Doc<"weekPlans">,
): Promise<void> {
  const reservation = plan.deletionReservation;
  if (!reservation || reservation.state === "cancelled_completed") return;
  if (reservation.state === "reserved") {
    for (const target of reservation.targets) {
      const workout = await ctx.db.get(target.workoutPlanId);
      if (
        workout?.weekPlanDeletionReservation?.claimId === reservation.claimId &&
        workout.weekPlanDeletionReservation.weekPlanId === plan._id
      ) {
        await ctx.db.patch(workout._id, { weekPlanDeletionReservation: undefined });
      }
    }
    await ctx.db.patch(plan._id, {
      deletionReservation: { ...reservation, state: "cancelled_completed" },
    });
    return;
  }
  await ctx.db.patch(plan._id, {
    deletionReservation: {
      ...reservation,
      state: "needs_attention",
      reason: "completion_recorded",
    },
  });
}
