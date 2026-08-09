import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import {
  COMPLETED_WEEK_PLAN_DELETE_ERROR,
  deletionTargetValidator,
} from "./weekPlanDeletionShared";
import {
  markWeekPlanDeletionSnapshotConflict as markSnapshotConflict,
  readWeekPlanDeletionSnapshot as readSnapshot,
  sameWeekPlanDeletionTargets as sameTargets,
} from "./weekPlanDeletionSnapshot";

const reservationResultValidator = v.union(
  v.object({
    status: v.literal("reserved"),
    claimId: v.string(),
    state: v.union(
      v.literal("reserved"),
      v.literal("remote_deleting"),
      v.literal("needs_attention"),
    ),
    targets: v.array(deletionTargetValidator),
  }),
  v.object({ status: v.literal("conflict"), error: v.string() }),
  v.object({ status: v.literal("missing") }),
);

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
        if (snapshot.error !== COMPLETED_WEEK_PLAN_DELETE_ERROR) {
          await markSnapshotConflict(ctx, plan);
        } else if (existing.state === "reserved") {
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
      const state: "reserved" | "remote_deleting" | "needs_attention" =
        existing.state === "reserved"
          ? "reserved"
          : existing.state === "remote_deleting"
            ? "remote_deleting"
            : "needs_attention";
      return {
        status: "reserved" as const,
        claimId: existing.claimId,
        state,
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
    return {
      status: "reserved" as const,
      claimId,
      state: "reserved" as const,
      targets: snapshot.targets,
    };
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
      reservation.state === "cancelled_completed" ||
      (reservation.state === "needs_attention" && reservation.reason !== "remote_failure") ||
      reservation.targets.some((t) => t.remoteStatus === "pending")
    ) {
      return { ok: false as const, error: "Remote deletion is not fully confirmed" };
    }
    const snapshot = await readSnapshot(ctx, plan);
    if (!snapshot.ok || !sameTargets(reservation.targets, snapshot.ok ? snapshot.targets : [])) {
      const completed = !snapshot.ok && snapshot.error === COMPLETED_WEEK_PLAN_DELETE_ERROR;
      await ctx.db.patch(plan._id, {
        deletionReservation: {
          ...reservation,
          state: "needs_attention",
          reason: completed ? "completion_recorded" : "snapshot_changed",
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
