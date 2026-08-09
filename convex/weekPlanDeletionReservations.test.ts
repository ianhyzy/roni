/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const NOW = 1_900_000_000_000;

async function seedLinkedWeek(options?: {
  readonly workoutStatus?: "draft" | "pushed" | "completed";
  readonly dayStatus?: "programmed" | "completed";
  readonly tonalWorkoutId?: string;
}) {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const workoutPlanId = await ctx.db.insert("workoutPlans", {
      userId,
      title: "Monday",
      blocks: [],
      status: options?.workoutStatus ?? "pushed",
      ...(options?.tonalWorkoutId === ""
        ? {}
        : { tonalWorkoutId: options?.tonalWorkoutId ?? "tonal-1" }),
      createdAt: 1,
    });
    const weekPlanId = await ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: "2026-08-03",
      preferredSplit: "upper_lower",
      targetDays: 1,
      days: [
        {
          sessionType: "upper",
          status: options?.dayStatus ?? "programmed",
          workoutPlanId,
        },
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
  return { t, ...seeded };
}

async function reserve(
  seeded: Awaited<ReturnType<typeof seedLinkedWeek>>,
  proposedClaimId = "delete-1",
) {
  return seeded.t.mutation(internal.weekPlanDeletionState.reserveWeekPlanDeletion, {
    userId: seeded.userId,
    weekPlanId: seeded.weekPlanId,
    proposedClaimId,
    now: NOW,
  });
}

describe("week-plan deletion reservations", () => {
  it("atomically snapshots and fences the week and every linked workout", async () => {
    const seeded = await seedLinkedWeek();

    const result = await reserve(seeded);

    expect(result).toEqual({
      status: "reserved",
      claimId: "delete-1",
      state: "reserved",
      targets: [
        {
          workoutPlanId: seeded.workoutPlanId,
          tonalWorkoutId: "tonal-1",
          remoteStatus: "pending",
        },
      ],
    });
    const rows = await seeded.t.run(async (ctx) => ({
      week: await ctx.db.get(seeded.weekPlanId),
      workout: await ctx.db.get(seeded.workoutPlanId),
    }));
    expect(rows.week?.deletionReservation).toMatchObject({
      claimId: "delete-1",
      state: "reserved",
      reservedAt: NOW,
    });
    expect(rows.workout?.weekPlanDeletionReservation).toEqual({
      claimId: "delete-1",
      weekPlanId: seeded.weekPlanId,
    });
  });

  it("blocks canonical, legacy, and durable-history completion before reservation", async () => {
    const canonical = await seedLinkedWeek({ dayStatus: "completed" });
    const legacy = await seedLinkedWeek({ workoutStatus: "completed" });
    const durable = await seedLinkedWeek();
    await durable.t.run((ctx) =>
      ctx.db.insert("completedWorkouts", {
        userId: durable.userId,
        activityId: "activity-1",
        date: "2026-08-03",
        title: "Monday",
        targetArea: "Upper",
        totalVolume: 1,
        totalDuration: 1,
        totalWork: 1,
        workoutType: "Custom",
        tonalWorkoutId: "tonal-1",
        syncedAt: NOW,
      }),
    );

    await expect(reserve(canonical)).resolves.toMatchObject({ status: "conflict" });
    await expect(reserve(legacy)).resolves.toMatchObject({ status: "conflict" });
    await expect(reserve(durable)).resolves.toMatchObject({ status: "conflict" });
  });

  it("records completion before remote work and permanently cancels finalization", async () => {
    const seeded = await seedLinkedWeek();
    await reserve(seeded);

    await seeded.t.mutation(internal.weekPlans.setDayStatusInternal, {
      weekPlanId: seeded.weekPlanId,
      dayIndex: 0,
      status: "completed",
    });

    const rows = await seeded.t.run(async (ctx) => ({
      week: await ctx.db.get(seeded.weekPlanId),
      workout: await ctx.db.get(seeded.workoutPlanId),
    }));
    expect(rows.week?.days[0]?.status).toBe("completed");
    expect(rows.week?.deletionReservation?.state).toBe("cancelled_completed");
    expect(rows.workout?.weekPlanDeletionReservation).toBeUndefined();
    await expect(
      seeded.t.mutation(internal.weekPlanDeletionState.finalizeWeekPlanDeletion, {
        userId: seeded.userId,
        weekPlanId: seeded.weekPlanId,
        claimId: "delete-1",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(seeded.t.run((ctx) => ctx.db.get(seeded.weekPlanId))).resolves.not.toBeNull();
  });

  it("records completion after remote authorization and retains recovery receipts", async () => {
    const seeded = await seedLinkedWeek();
    await reserve(seeded);
    await seeded.t.mutation(internal.weekPlanDeletionState.authorizeRemoteWorkoutDeletion, {
      userId: seeded.userId,
      weekPlanId: seeded.weekPlanId,
      claimId: "delete-1",
      workoutPlanId: seeded.workoutPlanId,
      tonalWorkoutId: "tonal-1",
    });

    await seeded.t.mutation(internal.weekPlans.batchUpdateDayStatusesInternal, {
      weekPlanId: seeded.weekPlanId,
      updates: [
        { dayIndex: 0, status: "completed" },
        { dayIndex: 0, status: "programmed" },
      ],
    });

    const rows = await seeded.t.run(async (ctx) => ({
      week: await ctx.db.get(seeded.weekPlanId),
      workout: await ctx.db.get(seeded.workoutPlanId),
    }));
    expect(rows.week?.days[0]?.status).toBe("completed");
    expect(rows.week?.deletionReservation).toMatchObject({
      state: "needs_attention",
      reason: "completion_recorded",
    });
    expect(rows.workout?.weekPlanDeletionReservation?.claimId).toBe("delete-1");
    await seeded.t.mutation(internal.weekPlanDeletionState.markDeletionNeedsAttention, {
      userId: seeded.userId,
      weekPlanId: seeded.weekPlanId,
      claimId: "delete-1",
    });
    const stillBlocked = await seeded.t.run((ctx) => ctx.db.get(seeded.weekPlanId));
    expect(stillBlocked?.deletionReservation).toMatchObject({
      state: "needs_attention",
      reason: "completion_recorded",
    });
    await expect(
      seeded.t.mutation(internal.weekPlanDeletionState.finalizeWeekPlanDeletion, {
        userId: seeded.userId,
        weekPlanId: seeded.weekPlanId,
        claimId: "delete-1",
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(seeded.t.run((ctx) => ctx.db.get(seeded.workoutPlanId))).resolves.not.toBeNull();
  });

  it("lets only approval or deletion claim a linked draft", async () => {
    const seeded = await seedLinkedWeek({ workoutStatus: "draft", tonalWorkoutId: "" });
    const expectedDraftFingerprint = JSON.stringify(["Monday", []]);

    const [deletion, approval] = await Promise.all([
      reserve(seeded),
      seeded.t.mutation(internal.weekPlanApproval.claimDraftForWeekPush, {
        userId: seeded.userId,
        weekPlanId: seeded.weekPlanId,
        dayIndex: 0,
        expectedWorkoutPlanId: seeded.workoutPlanId,
        expectedDraftFingerprint,
      }),
    ]);

    expect(
      [deletion.status === "reserved", approval.status === "claimed"].filter(Boolean),
    ).toHaveLength(1);
  });

  it("preserves all rows when durable completion lands after the remote checkpoint", async () => {
    const seeded = await seedLinkedWeek();
    await reserve(seeded);
    const target = {
      userId: seeded.userId,
      weekPlanId: seeded.weekPlanId,
      claimId: "delete-1",
      workoutPlanId: seeded.workoutPlanId,
      tonalWorkoutId: "tonal-1",
    };
    await seeded.t.mutation(internal.weekPlanDeletionState.authorizeRemoteWorkoutDeletion, target);
    await seeded.t.mutation(internal.weekPlanDeletionState.confirmRemoteWorkoutDeletion, target);
    await seeded.t.run((ctx) =>
      ctx.db.insert("completedWorkouts", {
        userId: seeded.userId,
        activityId: "late-completion",
        date: "2026-08-03",
        title: "Monday",
        targetArea: "Upper",
        totalVolume: 1,
        totalDuration: 1,
        totalWork: 1,
        workoutType: "Custom",
        tonalWorkoutId: "tonal-1",
        syncedAt: NOW,
      }),
    );

    await expect(
      seeded.t.mutation(internal.weekPlanDeletionState.finalizeWeekPlanDeletion, {
        userId: seeded.userId,
        weekPlanId: seeded.weekPlanId,
        claimId: "delete-1",
      }),
    ).resolves.toMatchObject({ ok: false });
    const week = await seeded.t.run((ctx) => ctx.db.get(seeded.weekPlanId));
    expect(week?.deletionReservation).toMatchObject({
      state: "needs_attention",
      reason: "completion_recorded",
    });
    await expect(seeded.t.run((ctx) => ctx.db.get(seeded.workoutPlanId))).resolves.not.toBeNull();
  });

  it("rejects relinking and scheduling while the reservation owns both links", async () => {
    const seeded = await seedLinkedWeek();
    await seeded.t.run((ctx) =>
      ctx.db.patch(seeded.workoutPlanId, {
        tonalWorkoutSignupId: "signup-1",
        tonalScheduledDate: "2026-08-03",
        tonalSchedulingReceiptVerifiedAt: NOW,
      }),
    );
    await reserve(seeded);
    const incomingWorkoutPlanId = await seeded.t.run((ctx) =>
      ctx.db.insert("workoutPlans", {
        userId: seeded.userId,
        title: "Incoming",
        blocks: [],
        status: "draft",
        createdAt: 2,
      }),
    );

    await expect(
      seeded.t.mutation(internal.weekPlanInternals.linkWorkoutPlanToDayInternal, {
        userId: seeded.userId,
        weekPlanId: seeded.weekPlanId,
        dayIndex: 0,
        workoutPlanId: incomingWorkoutPlanId,
      }),
    ).rejects.toThrow("being deleted");
    await expect(
      seeded.t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
        userId: seeded.userId,
        workoutPlanId: seeded.workoutPlanId,
        workoutId: "tonal-1",
        scheduledDate: "2026-08-03",
        claimId: "schedule-1",
        now: NOW,
      }),
    ).resolves.toEqual({ status: "busy", retryable: true });
  });

  it("rejects exact snapshot mismatches and preserves every local row", async () => {
    const seeded = await seedLinkedWeek();
    await reserve(seeded);
    await seeded.t.run((ctx) =>
      ctx.db.patch(seeded.workoutPlanId, { tonalWorkoutId: "changed-remotely" }),
    );

    const authorization = await seeded.t.mutation(
      internal.weekPlanDeletionState.authorizeRemoteWorkoutDeletion,
      {
        userId: seeded.userId,
        weekPlanId: seeded.weekPlanId,
        claimId: "delete-1",
        workoutPlanId: seeded.workoutPlanId,
        tonalWorkoutId: "tonal-1",
      },
    );

    expect(authorization).toMatchObject({ status: "blocked" });
    const week = await seeded.t.run((ctx) => ctx.db.get(seeded.weekPlanId));
    expect(week?.deletionReservation).toMatchObject({
      state: "needs_attention",
      reason: "snapshot_changed",
    });
    await expect(seeded.t.run((ctx) => ctx.db.get(seeded.workoutPlanId))).resolves.not.toBeNull();
  });

  it("never releases or lets a later claimant take over after remote authorization", async () => {
    const seeded = await seedLinkedWeek();
    await reserve(seeded, "original");
    await seeded.t.mutation(internal.weekPlanDeletionState.authorizeRemoteWorkoutDeletion, {
      userId: seeded.userId,
      weekPlanId: seeded.weekPlanId,
      claimId: "original",
      workoutPlanId: seeded.workoutPlanId,
      tonalWorkoutId: "tonal-1",
    });

    await expect(
      seeded.t.mutation(internal.weekPlanDeletionState.releaseReservedDeletion, {
        userId: seeded.userId,
        weekPlanId: seeded.weekPlanId,
        claimId: "original",
      }),
    ).resolves.toEqual({ released: false });
    await expect(reserve(seeded, "later")).resolves.toMatchObject({
      status: "reserved",
      claimId: "original",
      state: "remote_deleting",
    });
  });
});
