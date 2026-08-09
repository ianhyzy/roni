/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import {
  CLAIMED_WEEK_PLAN_DELETE_ERROR,
  MISSING_TONAL_WORKOUT_ID_DELETE_ERROR,
  SHARED_WORKOUT_DELETE_ERROR,
} from "./weekPlanDeletionShared";

const modules = import.meta.glob("./**/*.*s");
const NOW = 1_900_000_000_000;

async function seedReservedWeek() {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const workoutPlanId = await ctx.db.insert("workoutPlans", {
      userId,
      title: "Monday",
      blocks: [],
      status: "pushed",
      tonalWorkoutId: "tonal-1",
      createdAt: 1,
    });
    const weekPlanId = await ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: "2026-08-03",
      preferredSplit: "upper_lower",
      targetDays: 1,
      days: [
        { sessionType: "upper", status: "programmed", workoutPlanId },
        ...Array.from({ length: 6 }, () => ({
          sessionType: "rest" as const,
          status: "programmed" as const,
        })),
      ],
      createdAt: 1,
      updatedAt: 1,
    });
    return { userId, workoutPlanId, weekPlanId };
  });
  await t.mutation(internal.weekPlanDeletionState.reserveWeekPlanDeletion, {
    userId: seeded.userId,
    weekPlanId: seeded.weekPlanId,
    proposedClaimId: "delete-1",
    now: NOW,
  });
  return { t, ...seeded };
}

function deletionTarget(seeded: Awaited<ReturnType<typeof seedReservedWeek>>) {
  return {
    userId: seeded.userId,
    weekPlanId: seeded.weekPlanId,
    claimId: "delete-1",
    workoutPlanId: seeded.workoutPlanId,
    tonalWorkoutId: "tonal-1",
  };
}

describe("week-plan deletion conflict regressions", () => {
  it("refuses to delete a workout still linked from another week plan", async () => {
    const seeded = await seedReservedWeek();
    await seeded.t.mutation(internal.weekPlanDeletionState.releaseReservedDeletion, {
      userId: seeded.userId,
      weekPlanId: seeded.weekPlanId,
      claimId: "delete-1",
    });
    await seeded.t.run(async (ctx) => {
      const plan = await ctx.db.get(seeded.weekPlanId);
      if (!plan) throw new Error("Missing seeded week plan");
      await ctx.db.insert("weekPlans", {
        userId: seeded.userId,
        weekStartDate: "2026-08-10",
        preferredSplit: "upper_lower",
        targetDays: 1,
        days: plan.days,
        createdAt: 2,
        updatedAt: 2,
      });
    });

    await expect(
      seeded.t.mutation(internal.weekPlanDeletionState.reserveWeekPlanDeletion, {
        userId: seeded.userId,
        weekPlanId: seeded.weekPlanId,
        proposedClaimId: "delete-2",
        now: NOW + 1,
      }),
    ).resolves.toEqual({ status: "conflict", error: SHARED_WORKOUT_DELETE_ERROR });
    const workout = await seeded.t.run((ctx) => ctx.db.get(seeded.workoutPlanId));
    expect(workout?.weekPlanDeletionReservation).toBeUndefined();
  });

  it("fails closed when a pushed row has no exact Tonal target", async () => {
    const seeded = await seedReservedWeek();
    await seeded.t.mutation(internal.weekPlanDeletionState.releaseReservedDeletion, {
      userId: seeded.userId,
      weekPlanId: seeded.weekPlanId,
      claimId: "delete-1",
    });
    await seeded.t.run((ctx) => ctx.db.patch(seeded.workoutPlanId, { tonalWorkoutId: undefined }));

    await expect(
      seeded.t.mutation(internal.weekPlanDeletionState.reserveWeekPlanDeletion, {
        userId: seeded.userId,
        weekPlanId: seeded.weekPlanId,
        proposedClaimId: "delete-2",
        now: NOW + 1,
      }),
    ).resolves.toEqual({
      status: "conflict",
      error: MISSING_TONAL_WORKOUT_ID_DELETE_ERROR,
    });
  });

  it("classifies a new approval claim as a snapshot conflict, not a completion", async () => {
    const seeded = await seedReservedWeek();
    await seeded.t.run((ctx) => ctx.db.patch(seeded.workoutPlanId, { status: "pushing" }));

    const retry = await seeded.t.mutation(internal.weekPlanDeletionState.reserveWeekPlanDeletion, {
      userId: seeded.userId,
      weekPlanId: seeded.weekPlanId,
      proposedClaimId: "delete-2",
      now: NOW + 1,
    });

    expect(retry).toEqual({ status: "conflict", error: CLAIMED_WEEK_PLAN_DELETE_ERROR });
    const rows = await seeded.t.run(async (ctx) => ({
      week: await ctx.db.get(seeded.weekPlanId),
      workout: await ctx.db.get(seeded.workoutPlanId),
    }));
    expect(rows.week?.deletionReservation).toMatchObject({
      state: "needs_attention",
      reason: "snapshot_changed",
    });
    expect(rows.workout?.weekPlanDeletionReservation?.claimId).toBe("delete-1");
  });

  it("finalizes a remote-failure claim after every target has an absence receipt", async () => {
    const seeded = await seedReservedWeek();
    const target = deletionTarget(seeded);
    await seeded.t.mutation(internal.weekPlanDeletionState.authorizeRemoteWorkoutDeletion, target);
    await seeded.t.mutation(internal.weekPlanDeletionState.markDeletionNeedsAttention, {
      userId: seeded.userId,
      weekPlanId: seeded.weekPlanId,
      claimId: "delete-1",
    });
    await seeded.t.mutation(internal.weekPlanDeletionState.confirmRemoteWorkoutDeletion, target);

    await expect(
      seeded.t.mutation(internal.weekPlanDeletionState.finalizeWeekPlanDeletion, {
        userId: seeded.userId,
        weekPlanId: seeded.weekPlanId,
        claimId: "delete-1",
      }),
    ).resolves.toEqual({ ok: true, deleted: true });
    await expect(seeded.t.run((ctx) => ctx.db.get(seeded.workoutPlanId))).resolves.toBeNull();
    await expect(seeded.t.run((ctx) => ctx.db.get(seeded.weekPlanId))).resolves.toBeNull();
  });

  it("checkpoints a concurrent standalone Tonal deletion into the active claim", async () => {
    const seeded = await seedReservedWeek();

    await seeded.t.mutation(internal.workoutPlans.markDeleted, {
      tonalWorkoutId: "tonal-1",
    });

    const rows = await seeded.t.run(async (ctx) => ({
      week: await ctx.db.get(seeded.weekPlanId),
      workout: await ctx.db.get(seeded.workoutPlanId),
    }));
    expect(rows.week?.deletionReservation).toMatchObject({
      state: "remote_deleting",
      targets: [{ tonalWorkoutId: "tonal-1", remoteStatus: "absent" }],
    });
    expect(rows.workout?.status).toBe("deleted");
    await expect(
      seeded.t.mutation(internal.weekPlanDeletionState.finalizeWeekPlanDeletion, {
        userId: seeded.userId,
        weekPlanId: seeded.weekPlanId,
        claimId: "delete-1",
      }),
    ).resolves.toEqual({ ok: true, deleted: true });
  });
});
