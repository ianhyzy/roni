/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  CLAIMED_WEEK_PLAN_DELETE_ERROR,
  COMPLETED_WEEK_PLAN_DELETE_ERROR,
} from "./weekPlanDeletion";

const modules = import.meta.glob("./**/*.*s");

type WorkoutSeed = {
  status: Doc<"workoutPlans">["status"];
  tonalWorkoutId?: string;
  tonalScheduledDate?: string;
  tonalSchedulingClaim?: Doc<"workoutPlans">["tonalSchedulingClaim"];
};

async function seedWeekPlan(t: ReturnType<typeof convexTest>, workouts: WorkoutSeed[]) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const workoutPlanIds: Id<"workoutPlans">[] = [];
    for (const [index, workout] of workouts.entries()) {
      workoutPlanIds.push(
        await ctx.db.insert("workoutPlans", {
          userId,
          title: `Day ${index}`,
          blocks: [],
          status: workout.status,
          createdAt: Date.now(),
          ...(workout.tonalWorkoutId ? { tonalWorkoutId: workout.tonalWorkoutId } : {}),
          ...(workout.tonalScheduledDate ? { tonalScheduledDate: workout.tonalScheduledDate } : {}),
          ...(workout.tonalSchedulingClaim
            ? { tonalSchedulingClaim: workout.tonalSchedulingClaim }
            : {}),
        }),
      );
    }
    const weekPlanId = await ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: "2026-08-03",
      preferredSplit: "upper_lower",
      targetDays: workoutPlanIds.length,
      days: Array.from({ length: 7 }, (_, dayIndex) => {
        const workoutPlanId = workoutPlanIds[dayIndex];
        return workoutPlanId
          ? {
              sessionType: "upper" as const,
              status: "programmed" as const,
              workoutPlanId,
            }
          : { sessionType: "rest" as const, status: "programmed" as const };
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return { userId, weekPlanId, workoutPlanIds };
  });
}

describe("getWeekPlanDeletionState", () => {
  it("collects the Tonal ids of pushed workouts so they can be removed remotely", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId } = await seedWeekPlan(t, [
      { status: "pushed", tonalWorkoutId: "tw-1", tonalScheduledDate: "2026-08-03" },
      { status: "pushed", tonalWorkoutId: "tw-2", tonalScheduledDate: "2026-08-04" },
      { status: "draft" },
    ]);

    const state = await t.query(internal.weekPlanDeletion.getWeekPlanDeletionState, {
      userId,
      weekPlanId,
    });

    // Scheduled workouts used to hard-block the whole delete; now they are the
    // ones we clean off Tonal first.
    expect(state).toEqual({ ok: true, tonalWorkoutIds: ["tw-1", "tw-2"] });
  });

  it("refuses when a session was already completed", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId } = await seedWeekPlan(t, [
      { status: "pushed", tonalWorkoutId: "tw-1" },
      { status: "completed", tonalWorkoutId: "tw-2" },
    ]);

    await expect(
      t.query(internal.weekPlanDeletion.getWeekPlanDeletionState, { userId, weekPlanId }),
    ).resolves.toEqual({ ok: false, error: COMPLETED_WEEK_PLAN_DELETE_ERROR });
  });

  it("refuses a completed day even when its linked workout remains pushed", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId } = await seedWeekPlan(t, [
      { status: "pushed", tonalWorkoutId: "tw-1" },
    ]);
    await t.mutation(internal.weekPlans.setDayStatusInternal, {
      weekPlanId,
      dayIndex: 0,
      status: "completed",
    });

    await expect(
      t.query(internal.weekPlanDeletion.getWeekPlanDeletionState, { userId, weekPlanId }),
    ).resolves.toEqual({ ok: false, error: COMPLETED_WEEK_PLAN_DELETE_ERROR });
  });

  it("refuses while a scheduling claim is outstanding, even an expired one", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId } = await seedWeekPlan(t, [
      {
        status: "pushed",
        tonalWorkoutId: "tw-1",
        tonalSchedulingClaim: {
          claimId: "claim-1",
          workoutId: "tw-1",
          scheduledDate: "2026-08-03",
          phase: "post_authorized",
          leaseExpiresAt: 1,
        },
      },
    ]);

    await expect(
      t.query(internal.weekPlanDeletion.getWeekPlanDeletionState, { userId, weekPlanId }),
    ).resolves.toEqual({ ok: false, error: CLAIMED_WEEK_PLAN_DELETE_ERROR });
  });

  it("denies a plan owned by someone else", async () => {
    const t = convexTest(schema, modules);
    const { weekPlanId } = await seedWeekPlan(t, [{ status: "draft" }]);
    const otherUserId = await t.run((ctx) => ctx.db.insert("users", {}));

    await expect(
      t.query(internal.weekPlanDeletion.getWeekPlanDeletionState, {
        userId: otherUserId,
        weekPlanId,
      }),
    ).resolves.toEqual({ ok: false, error: "Week plan access denied" });
  });

  it("has nothing to remove for a draft-only week", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId } = await seedWeekPlan(t, [
      { status: "draft" },
      { status: "draft" },
    ]);

    await expect(
      t.query(internal.weekPlanDeletion.getWeekPlanDeletionState, { userId, weekPlanId }),
    ).resolves.toEqual({ ok: true, tonalWorkoutIds: [] });
  });
});

describe("deleteWeekPlanInternal allowPushed", () => {
  it("still refuses pushed workouts without the flag", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId } = await seedWeekPlan(t, [
      { status: "pushed", tonalWorkoutId: "tw-1" },
    ]);

    await expect(
      t.mutation(internal.weekPlans.deleteWeekPlanInternal, { userId, weekPlanId }),
    ).resolves.toEqual({ ok: false, error: "Only draft week plans can be deleted" });
  });

  it("cannot bypass remote deletion receipts with the legacy allowPushed flag", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId } = await seedWeekPlan(t, [
      { status: "pushed", tonalWorkoutId: "tw-1", tonalScheduledDate: "2026-08-03" },
    ]);

    await expect(
      t.mutation(internal.weekPlans.deleteWeekPlanInternal, {
        userId,
        weekPlanId,
        allowPushed: true,
      }),
    ).resolves.toEqual({ ok: false, error: "Only draft week plans can be deleted" });
    await expect(t.run((ctx) => ctx.db.get(weekPlanId))).resolves.not.toBeNull();
  });

  it("never lets allowPushed override an in-flight scheduling claim", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId } = await seedWeekPlan(t, [
      {
        status: "pushed",
        tonalWorkoutId: "tw-1",
        tonalSchedulingClaim: {
          claimId: "claim-1",
          workoutId: "tw-1",
          scheduledDate: "2026-08-03",
          phase: "checking",
          leaseExpiresAt: Date.now() + 60_000,
        },
      },
    ]);

    await expect(
      t.mutation(internal.weekPlans.deleteWeekPlanInternal, {
        userId,
        weekPlanId,
        allowPushed: true,
      }),
    ).resolves.toEqual({ ok: false, error: "Workout scheduling is in progress" });
  });

  it("rechecks completed days after preflight before deleting local rows", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId, workoutPlanIds } = await seedWeekPlan(t, [
      { status: "pushed", tonalWorkoutId: "tw-1" },
    ]);
    await expect(
      t.query(internal.weekPlanDeletion.getWeekPlanDeletionState, { userId, weekPlanId }),
    ).resolves.toEqual({ ok: true, tonalWorkoutIds: ["tw-1"] });
    await t.mutation(internal.weekPlans.setDayStatusInternal, {
      weekPlanId,
      dayIndex: 0,
      status: "completed",
    });

    await expect(
      t.mutation(internal.weekPlans.deleteWeekPlanInternal, {
        userId,
        weekPlanId,
        allowPushed: true,
      }),
    ).resolves.toEqual({ ok: false, error: COMPLETED_WEEK_PLAN_DELETE_ERROR });
    const retainedRows = await t.run(async (ctx) => ({
      plan: await ctx.db.get(weekPlanId),
      workout: await ctx.db.get(workoutPlanIds[0]),
    }));
    expect(retainedRows.plan).not.toBeNull();
    expect(retainedRows.workout).not.toBeNull();
  });

  it("never lets allowPushed override a completed workout status", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId, workoutPlanIds } = await seedWeekPlan(t, [
      { status: "completed", tonalWorkoutId: "tw-1" },
    ]);

    await expect(
      t.mutation(internal.weekPlans.deleteWeekPlanInternal, {
        userId,
        weekPlanId,
        allowPushed: true,
      }),
    ).resolves.toEqual({ ok: false, error: COMPLETED_WEEK_PLAN_DELETE_ERROR });
    const retainedRows = await t.run(async (ctx) => ({
      plan: await ctx.db.get(weekPlanId),
      workout: await ctx.db.get(workoutPlanIds[0]),
    }));
    expect(retainedRows.plan).not.toBeNull();
    expect(retainedRows.workout).not.toBeNull();
  });
});
