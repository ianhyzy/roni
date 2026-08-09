import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import {
  CLAIMED_WEEK_PLAN_DELETE_ERROR,
  COMPLETED_WEEK_PLAN_DELETE_ERROR,
  deletionTargetValidator,
} from "./weekPlanDeletionShared";

type Target = {
  workoutPlanId: Id<"workoutPlans">;
  tonalWorkoutId: string | null;
  remoteStatus: "not_required" | "pending" | "absent";
};

const reservationResultValidator = v.union(
  v.object({
    status: v.literal("reserved"),
    claimId: v.string(),
    state: v.string(),
    targets: v.array(deletionTargetValidator),
  }),
  v.object({ status: v.literal("conflict"), error: v.string() }),
  v.object({ status: v.literal("missing") }),
);

function linkedIds(plan: Doc<"weekPlans">): Id<"workoutPlans">[] {
  return [...new Set(plan.days.flatMap((day) => (day.workoutPlanId ? [day.workoutPlanId] : [])))];
}

function sameTargets(left: readonly Target[], right: readonly Target[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (target, index) =>
        target.workoutPlanId === right[index]?.workoutPlanId &&
        target.tonalWorkoutId === right[index]?.tonalWorkoutId,
    )
  );
}

async function readSnapshot(
  ctx: MutationCtx,
  plan: Doc<"weekPlans">,
): Promise<{ ok: true; targets: Target[] } | { ok: false; error: string }> {
  if (plan.days.some((day) => day.status === "completed")) {
    return { ok: false, error: COMPLETED_WEEK_PLAN_DELETE_ERROR };
  }
  const targets: Target[] = [];
  for (const workoutPlanId of linkedIds(plan)) {
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
    const tonalWorkoutId = workout.tonalWorkoutId ?? null;
    targets.push({
      workoutPlanId,
      tonalWorkoutId,
      remoteStatus:
        tonalWorkoutId && workout.status !== "draft" && workout.status !== "deleted"
          ? "pending"
          : "not_required",
    });
  }
  return { ok: true, targets };
}

async function markSnapshotConflict(ctx: MutationCtx, plan: Doc<"weekPlans">): Promise<void> {
  const reservation = plan.deletionReservation;
  if (!reservation || reservation.state === "cancelled_completed") return;
  await ctx.db.patch(plan._id, {
    deletionReservation: { ...reservation, state: "needs_attention", reason: "snapshot_changed" },
  });
}

/** Atomically freezes the exact local/remote rows before any Tonal DELETE. */
export const reserveWeekPlanDeletion = internalMutation({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    proposedClaimId: v.string(),
    now: v.number(),
  },
  returns: reservationResultValidator,
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.now) || args.now < 0 || args.proposedClaimId.trim() === "") {
      throw new Error("Invalid week-plan deletion claim");
    }
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan) return { status: "missing" as const };
    if (plan.userId !== args.userId) {
      return { status: "conflict" as const, error: "Week plan access denied" };
    }
    const snapshot = await readSnapshot(ctx, plan);
    if (!snapshot.ok) {
      const existing = plan.deletionReservation;
      if (existing && existing.state !== "cancelled_completed") {
        if (existing.state === "reserved") {
          for (const target of existing.targets) {
            const workout = await ctx.db.get(target.workoutPlanId);
            if (workout?.weekPlanDeletionReservation?.claimId === existing.claimId) {
              await ctx.db.patch(workout._id, { weekPlanDeletionReservation: undefined });
            }
          }
          await ctx.db.patch(plan._id, {
            deletionReservation: { ...existing, state: "cancelled_completed" },
          });
        } else {
          await ctx.db.patch(plan._id, {
            deletionReservation: {
              ...existing,
              state: "needs_attention",
              reason: "completion_recorded",
            },
          });
        }
      }
      return { status: "conflict" as const, error: snapshot.error };
    }

    const existing = plan.deletionReservation;
    if (existing) {
      if (existing.state === "cancelled_completed") {
        return { status: "conflict" as const, error: COMPLETED_WEEK_PLAN_DELETE_ERROR };
      }
      if (!sameTargets(existing.targets, snapshot.targets)) {
        await markSnapshotConflict(ctx, plan);
        return { status: "conflict" as const, error: "Week-plan deletion snapshot changed" };
      }
      return {
        status: "reserved" as const,
        claimId: existing.claimId,
        state: existing.state,
        targets: existing.targets,
      };
    }

    for (const target of snapshot.targets) {
      const workout = await ctx.db.get(target.workoutPlanId);
      if (workout?.weekPlanDeletionReservation) {
        return { status: "conflict" as const, error: "Linked workout is already being deleted" };
      }
    }
    const claimId = args.proposedClaimId.trim();
    for (const target of snapshot.targets) {
      await ctx.db.patch(target.workoutPlanId, {
        weekPlanDeletionReservation: { claimId, weekPlanId: plan._id },
      });
    }
    await ctx.db.patch(plan._id, {
      deletionReservation: {
        claimId,
        state: "reserved",
        reservedAt: args.now,
        targets: snapshot.targets,
      },
    });
    return { status: "reserved" as const, claimId, state: "reserved", targets: snapshot.targets };
  },
});

const targetAuthorizationValidator = v.union(
  v.object({ status: v.literal("call") }),
  v.object({ status: v.literal("skip") }),
  v.object({ status: v.literal("blocked"), error: v.string() }),
);

/** Revalidates the reservation immediately before one specific remote call. */
export const authorizeRemoteWorkoutDeletion = internalMutation({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    claimId: v.string(),
    workoutPlanId: v.id("workoutPlans"),
    tonalWorkoutId: v.string(),
  },
  returns: targetAuthorizationValidator,
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan || plan.userId !== args.userId) {
      return { status: "blocked" as const, error: "Week plan not found or access denied" };
    }
    const reservation = plan.deletionReservation;
    if (!reservation || reservation.claimId !== args.claimId) {
      return { status: "blocked" as const, error: "Week-plan deletion claim was lost" };
    }
    if (reservation.state === "cancelled_completed") {
      return { status: "blocked" as const, error: COMPLETED_WEEK_PLAN_DELETE_ERROR };
    }
    if (reservation.state === "needs_attention" && reservation.reason !== "remote_failure") {
      return { status: "blocked" as const, error: "Week-plan deletion needs manual attention" };
    }
    const snapshot = await readSnapshot(ctx, plan);
    if (!snapshot.ok) {
      await ctx.db.patch(plan._id, {
        deletionReservation: {
          ...reservation,
          state: "needs_attention",
          reason:
            snapshot.error === COMPLETED_WEEK_PLAN_DELETE_ERROR
              ? "completion_recorded"
              : "snapshot_changed",
        },
      });
      return { status: "blocked" as const, error: snapshot.error };
    }
    if (!sameTargets(reservation.targets, snapshot.targets)) {
      await markSnapshotConflict(ctx, plan);
      return { status: "blocked" as const, error: "Week-plan deletion snapshot changed" };
    }
    const target = reservation.targets.find((item) => item.workoutPlanId === args.workoutPlanId);
    if (!target || target.tonalWorkoutId !== args.tonalWorkoutId) {
      await markSnapshotConflict(ctx, plan);
      return { status: "blocked" as const, error: "Week-plan deletion target changed" };
    }
    const workout = await ctx.db.get(target.workoutPlanId);
    if (
      workout?.weekPlanDeletionReservation?.claimId !== args.claimId ||
      workout.weekPlanDeletionReservation.weekPlanId !== plan._id
    ) {
      await markSnapshotConflict(ctx, plan);
      return { status: "blocked" as const, error: "Week-plan deletion fence changed" };
    }
    if (target.remoteStatus !== "pending") return { status: "skip" as const };
    if (reservation.state !== "remote_deleting") {
      await ctx.db.patch(plan._id, {
        deletionReservation: {
          claimId: reservation.claimId,
          state: "remote_deleting",
          reservedAt: reservation.reservedAt,
          targets: reservation.targets,
        },
      });
    }
    return { status: "call" as const };
  },
});

/** Checkpoints 204 or 404 as durable proof that this exact target is absent. */
export const confirmRemoteWorkoutDeletion = internalMutation({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    claimId: v.string(),
    workoutPlanId: v.id("workoutPlans"),
    tonalWorkoutId: v.string(),
  },
  returns: v.object({ confirmed: v.boolean() }),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.weekPlanId);
    const reservation = plan?.deletionReservation;
    if (
      !plan ||
      plan.userId !== args.userId ||
      !reservation ||
      reservation.claimId !== args.claimId
    ) {
      return { confirmed: false };
    }
    if (reservation.state !== "remote_deleting" && reservation.state !== "needs_attention") {
      return { confirmed: false };
    }
    const index = reservation.targets.findIndex(
      (target) =>
        target.workoutPlanId === args.workoutPlanId &&
        target.tonalWorkoutId === args.tonalWorkoutId,
    );
    if (index < 0) return { confirmed: false };
    const targets = [...reservation.targets];
    targets[index] = { ...targets[index], remoteStatus: "absent" };
    await ctx.db.patch(plan._id, { deletionReservation: { ...reservation, targets } });
    return { confirmed: true };
  },
});

export const markDeletionNeedsAttention = internalMutation({
  args: { userId: v.id("users"), weekPlanId: v.id("weekPlans"), claimId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.weekPlanId);
    const reservation = plan?.deletionReservation;
    if (
      plan?.userId === args.userId &&
      reservation?.claimId === args.claimId &&
      (reservation.state === "remote_deleting" ||
        (reservation.state === "needs_attention" && reservation.reason === "remote_failure"))
    ) {
      await ctx.db.patch(plan._id, {
        deletionReservation: { ...reservation, state: "needs_attention", reason: "remote_failure" },
      });
    }
    return null;
  },
});

/** The only mutation allowed to remove rows; stored receipts and snapshot must still match. */
export const finalizeWeekPlanDeletion = internalMutation({
  args: { userId: v.id("users"), weekPlanId: v.id("weekPlans"), claimId: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), deleted: v.boolean() }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan) return { ok: true as const, deleted: false };
    if (plan.userId !== args.userId)
      return { ok: false as const, error: "Week plan access denied" };
    const reservation = plan.deletionReservation;
    if (!reservation || reservation.claimId !== args.claimId) {
      return { ok: false as const, error: "Week-plan deletion claim was lost" };
    }
    if (
      (reservation.state !== "remote_deleting" && reservation.state !== "reserved") ||
      reservation.targets.some((t) => t.remoteStatus === "pending")
    ) {
      return { ok: false as const, error: "Remote deletion is not fully confirmed" };
    }
    const snapshot = await readSnapshot(ctx, plan);
    if (!snapshot.ok || !sameTargets(reservation.targets, snapshot.ok ? snapshot.targets : [])) {
      await ctx.db.patch(plan._id, {
        deletionReservation: {
          ...reservation,
          state: "needs_attention",
          reason: snapshot.ok ? "snapshot_changed" : "completion_recorded",
        },
      });
      return {
        ok: false as const,
        error: snapshot.ok ? "Week-plan deletion snapshot changed" : snapshot.error,
      };
    }
    for (const target of reservation.targets) {
      const workout = await ctx.db.get(target.workoutPlanId);
      if (
        !workout ||
        workout.userId !== args.userId ||
        workout.status === "completed" ||
        workout.tonalWorkoutId !== (target.tonalWorkoutId ?? undefined) ||
        workout.weekPlanDeletionReservation?.claimId !== args.claimId ||
        workout.weekPlanDeletionReservation.weekPlanId !== plan._id
      ) {
        await markSnapshotConflict(ctx, plan);
        return { ok: false as const, error: "Week-plan deletion snapshot changed" };
      }
    }
    for (const target of reservation.targets) await ctx.db.delete(target.workoutPlanId);
    await ctx.db.delete(plan._id);
    return { ok: true as const, deleted: true };
  },
});

/** Only an untouched pre-side-effect reservation is safe to abandon. */
export const releaseReservedDeletion = internalMutation({
  args: { userId: v.id("users"), weekPlanId: v.id("weekPlans"), claimId: v.string() },
  returns: v.object({ released: v.boolean() }),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.weekPlanId);
    const reservation = plan?.deletionReservation;
    if (
      plan?.userId !== args.userId ||
      reservation?.claimId !== args.claimId ||
      reservation.state !== "reserved"
    ) {
      return { released: false };
    }
    for (const target of reservation.targets) {
      const workout = await ctx.db.get(target.workoutPlanId);
      if (workout?.weekPlanDeletionReservation?.claimId === args.claimId) {
        await ctx.db.patch(workout._id, { weekPlanDeletionReservation: undefined });
      }
    }
    await ctx.db.patch(plan._id, { deletionReservation: undefined });
    return { released: true };
  },
});
