import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  CLAIMED_WEEK_PLAN_DELETE_ERROR,
  COMPLETED_WEEK_PLAN_DELETE_ERROR,
  MISSING_TONAL_WORKOUT_ID_DELETE_ERROR,
  SHARED_WORKOUT_DELETE_ERROR,
} from "./weekPlanDeletionShared";

const MAX_WEEK_PLANS_FOR_LINK_CHECK = 256;

export type WeekPlanDeletionTarget = {
  workoutPlanId: Id<"workoutPlans">;
  tonalWorkoutId: string | null;
  remoteStatus: "not_required" | "pending" | "absent";
};

function linkedIds(plan: Doc<"weekPlans">): Id<"workoutPlans">[] {
  return [...new Set(plan.days.flatMap((day) => (day.workoutPlanId ? [day.workoutPlanId] : [])))];
}

export function sameWeekPlanDeletionTargets(
  left: readonly WeekPlanDeletionTarget[],
  right: readonly WeekPlanDeletionTarget[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (target, index) =>
        target.workoutPlanId === right[index]?.workoutPlanId &&
        target.tonalWorkoutId === right[index]?.tonalWorkoutId,
    )
  );
}

export async function readWeekPlanDeletionSnapshot(
  ctx: { db: QueryCtx["db"] },
  plan: Doc<"weekPlans">,
): Promise<{ ok: true; targets: WeekPlanDeletionTarget[] } | { ok: false; error: string }> {
  if (plan.days.some((day) => day.status === "completed")) {
    return { ok: false, error: COMPLETED_WEEK_PLAN_DELETE_ERROR };
  }
  const workoutPlanIds = linkedIds(plan);
  const userPlans = await ctx.db
    .query("weekPlans")
    .withIndex("by_userId_weekStartDate", (q) => q.eq("userId", plan.userId))
    .take(MAX_WEEK_PLANS_FOR_LINK_CHECK + 1);
  if (userPlans.length > MAX_WEEK_PLANS_FOR_LINK_CHECK) {
    return { ok: false, error: "Too many week plans to verify linked workouts safely" };
  }
  const linkedWorkoutPlanIds = new Set(workoutPlanIds);
  if (
    userPlans.some(
      (candidate) =>
        candidate._id !== plan._id &&
        candidate.days.some(
          (day) => day.workoutPlanId && linkedWorkoutPlanIds.has(day.workoutPlanId),
        ),
    )
  ) {
    return { ok: false, error: SHARED_WORKOUT_DELETE_ERROR };
  }
  const targets: WeekPlanDeletionTarget[] = [];
  for (const workoutPlanId of workoutPlanIds) {
    const workout = await ctx.db.get(workoutPlanId);
    if (!workout) return { ok: false, error: "Linked workout not found" };
    if (workout.userId !== plan.userId) return { ok: false, error: "Linked workout access denied" };
    if (workout.status === "completed") {
      return { ok: false, error: COMPLETED_WEEK_PLAN_DELETE_ERROR };
    }
    if (workout.tonalWorkoutId) {
      const completed = await ctx.db
        .query("completedWorkouts")
        .withIndex("by_userId_tonalWorkoutId", (q) =>
          q.eq("userId", plan.userId).eq("tonalWorkoutId", workout.tonalWorkoutId),
        )
        .first();
      if (completed) return { ok: false, error: COMPLETED_WEEK_PLAN_DELETE_ERROR };
    }
    if (workout.tonalSchedulingClaim || workout.status === "pushing") {
      return { ok: false, error: CLAIMED_WEEK_PLAN_DELETE_ERROR };
    }
    if (workout.status === "pushed" && !workout.tonalWorkoutId) {
      return { ok: false, error: MISSING_TONAL_WORKOUT_ID_DELETE_ERROR };
    }
    const tonalWorkoutId = workout.tonalWorkoutId ?? null;
    targets.push({
      workoutPlanId,
      tonalWorkoutId,
      remoteStatus: tonalWorkoutId && workout.status !== "deleted" ? "pending" : "not_required",
    });
  }
  return { ok: true, targets };
}

export async function markWeekPlanDeletionSnapshotConflict(
  ctx: MutationCtx,
  plan: Doc<"weekPlans">,
): Promise<void> {
  const reservation = plan.deletionReservation;
  if (
    !reservation ||
    reservation.state === "cancelled_completed" ||
    (reservation.state === "needs_attention" && reservation.reason === "completion_recorded")
  ) {
    return;
  }
  await ctx.db.patch(plan._id, {
    deletionReservation: { ...reservation, state: "needs_attention", reason: "snapshot_changed" },
  });
}
