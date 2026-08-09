import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";

export const COMPLETED_WEEK_PLAN_DELETE_ERROR =
  "This week has completed sessions, so it can't be deleted. Delete the individual draft days instead.";
export const CLAIMED_WEEK_PLAN_DELETE_ERROR =
  "Workout scheduling or approval is in progress for this week. Try again in a minute.";
export const WEEK_PLAN_DELETION_IN_PROGRESS_ERROR =
  "This week plan is being deleted. Wait for deletion to finish before changing it.";

export const deletionTargetValidator = v.object({
  workoutPlanId: v.id("workoutPlans"),
  tonalWorkoutId: v.union(v.string(), v.null()),
  remoteStatus: v.union(v.literal("not_required"), v.literal("pending"), v.literal("absent")),
});

const deletionReservationBase = {
  claimId: v.string(),
  reservedAt: v.number(),
  targets: v.array(deletionTargetValidator),
};

/** Persisted state makes it impossible to confuse a pre-call lease with remote proof. */
export const weekPlanDeletionReservationValidator = v.union(
  v.object({ ...deletionReservationBase, state: v.literal("reserved") }),
  v.object({ ...deletionReservationBase, state: v.literal("remote_deleting") }),
  v.object({
    ...deletionReservationBase,
    state: v.literal("needs_attention"),
    reason: v.union(
      v.literal("remote_failure"),
      v.literal("completion_recorded"),
      v.literal("snapshot_changed"),
    ),
  }),
  v.object({
    ...deletionReservationBase,
    state: v.literal("cancelled_completed"),
  }),
);

export function isWeekPlanDeletionReserved(
  plan: Pick<Doc<"weekPlans">, "deletionReservation">,
): boolean {
  const state = plan.deletionReservation?.state;
  return state !== undefined && state !== "cancelled_completed";
}

export function isWorkoutReservedForWeekPlanDeletion(
  workout: Pick<Doc<"workoutPlans">, "weekPlanDeletionReservation">,
): boolean {
  return workout.weekPlanDeletionReservation !== undefined;
}
