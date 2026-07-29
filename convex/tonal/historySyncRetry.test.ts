/// <reference types="vite/client" />
import aggregateTest from "@convex-dev/aggregate/test";
import { convexTest } from "convex-test";
import { type FunctionArgs, getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import schema from "../schema";
import { syncActivitiesAndStrength } from "./historySyncCore";
import type { Activity, SetActivity, WorkoutActivityDetail } from "./types";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? "../tonal/" + key.slice(2) : key] = value;
}

type FunctionReferenceInput = Parameters<typeof getFunctionName>[0];

const ACTIVITY_TIME = "2026-06-01T12:00:00Z";
const ACTIVITY_DATE = "2026-06-01";
const TEST_USER_ID = "user-123" as Id<"users">;

function buildActivity(activityId: string): Activity {
  return {
    activityId,
    userId: "tonal-user",
    activityTime: ACTIVITY_TIME,
    activityType: "strength",
    workoutPreview: {
      activityId,
      workoutId: `workout-${activityId}`,
      workoutTitle: "Upper Body",
      programName: "",
      coachName: "",
      level: "",
      targetArea: "Upper Body",
      isGuidedWorkout: false,
      workoutType: "strength",
      beginTime: ACTIVITY_TIME,
      totalDuration: 1800,
      totalVolume: 1200,
      totalWork: 800,
      totalAchievements: 0,
      activityType: "strength",
    },
  };
}

function buildSet(
  id: string,
  movementId: string,
  blockNumber: number,
  avgWeight: number,
): SetActivity {
  return {
    id,
    movementId,
    repetition: 10,
    repetitionTotal: 10,
    blockNumber,
    spotter: false,
    eccentric: false,
    chains: false,
    flex: false,
    warmUp: false,
    beginTime: ACTIVITY_TIME,
    sideNumber: 0,
    avgWeight,
  };
}

function buildDetail(activityId: string): WorkoutActivityDetail {
  return {
    id: activityId,
    userId: "tonal-user",
    workoutId: `workout-${activityId}`,
    workoutType: "strength",
    timezone: "America/Denver",
    beginTime: ACTIVITY_TIME,
    endTime: "2026-06-01T12:30:00Z",
    totalDuration: 1800,
    activeDuration: 1500,
    restDuration: 300,
    totalMovements: 2,
    totalSets: 2,
    totalReps: 20,
    totalVolume: 1200,
    totalConcentricWork: 800,
    percentCompleted: 100,
    workoutSetActivity: [
      buildSet(`${activityId}-set-1`, "bench-press", 1, 100),
      buildSet(`${activityId}-set-2`, "lat-pulldown", 2, 80),
    ],
  };
}

function referenceName(ref: unknown): string {
  return getFunctionName(ref as FunctionReferenceInput);
}

describe("history sync retry completion", () => {
  test("only treats explicitly finalized workouts as complete", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const workout = {
      date: ACTIVITY_DATE,
      title: "Upper Body",
      targetArea: "Upper Body",
      totalVolume: 1200,
      totalDuration: 1800,
      totalWork: 800,
      workoutType: "strength",
    };

    await t.run(async (ctx) => {
      await ctx.db.insert("completedWorkouts", {
        userId,
        activityId: "legacy-partial",
        ...workout,
        syncedAt: 1,
      });
    });
    await t.mutation(internal.tonal.historySyncMutations.persistCompletedWorkouts, {
      userId,
      workouts: [{ activityId: "finalized", ...workout }],
    });

    const completedIds = await t.query(internal.tonal.historySyncMutations.getExistingActivityIds, {
      userId,
      activityIds: ["legacy-partial", "finalized"],
    });

    expect(completedIds).toEqual(["finalized"]);
  });

  test("retries the batch when any workout detail is unavailable", async () => {
    const unavailable = buildActivity("unavailable");
    const valid = buildActivity("valid");
    const runMutation = vi.fn(async (_ref: unknown, _args: unknown) => undefined);
    const ctx = {
      runQuery: vi.fn(async (ref: unknown) => {
        const name = referenceName(ref);
        if (name.endsWith(":getExistingActivityIds")) return [];
        if (name.endsWith(":getAllMovements")) return [];
        throw new Error(`Unexpected query: ${name}`);
      }),
      runAction: vi.fn(async (ref: unknown, args: unknown) => {
        const name = referenceName(ref);
        if (name.endsWith(":fetchWorkoutDetail")) {
          const { activityId } = args as { activityId: string };
          return activityId === unavailable.activityId ? null : buildDetail(activityId);
        }
        if (name.endsWith(":fetchFormattedSummary")) return { movementSets: [] };
        throw new Error(`Unexpected action: ${name}`);
      }),
      runMutation,
    } as unknown as ActionCtx;

    await expect(
      syncActivitiesAndStrength(ctx, TEST_USER_ID, [unavailable, valid]),
    ).rejects.toThrow(`Workout detail unavailable for activity ${unavailable.activityId}`);
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("propagates rejected detail fetches without finalizing workouts", async () => {
    const runMutation = vi.fn();
    const ctx = {
      runQuery: vi.fn(async (ref: unknown) => {
        const name = referenceName(ref);
        if (name.endsWith(":getExistingActivityIds")) return [];
        if (name.endsWith(":getAllMovements")) return [];
        throw new Error(`Unexpected query: ${name}`);
      }),
      runAction: vi.fn(async () => {
        throw new Error("session expired");
      }),
      runMutation,
    } as unknown as ActionCtx;

    await expect(
      syncActivitiesAndStrength(ctx, TEST_USER_ID, [buildActivity("auth-failure")]),
    ).rejects.toThrow("session expired");
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("the next sync backfills a legacy partial workout before finalizing it", async () => {
    const t = convexTest(schema, modules);
    aggregateTest.register(t, "perfByMovement");
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const activity = buildActivity("legacy-partial");
    const workout = {
      activityId: activity.activityId,
      date: ACTIVITY_DATE,
      title: activity.workoutPreview.workoutTitle,
      targetArea: activity.workoutPreview.targetArea,
      totalVolume: activity.workoutPreview.totalVolume,
      totalDuration: activity.workoutPreview.totalDuration,
      totalWork: activity.workoutPreview.totalWork,
      workoutType: activity.workoutPreview.workoutType,
      tonalWorkoutId: activity.workoutPreview.workoutId,
    };

    await t.run(async (ctx) => {
      await ctx.db.insert("completedWorkouts", {
        userId,
        ...workout,
        title: "Stale title",
        targetArea: "Stale target",
        workoutType: "stale-type",
        tonalWorkoutId: "stale-workout-id",
        syncedAt: 1,
      });
    });
    await t.mutation(internal.tonal.historySyncMutations.persistExercisePerformance, {
      userId,
      performances: [
        {
          activityId: workout.activityId,
          movementId: "bench-press",
          date: workout.date,
          sets: 1,
          totalReps: 10,
          avgWeightLbs: 100,
        },
      ],
    });

    const ctx = {
      runQuery: async (ref: unknown, args?: unknown) => {
        const name = referenceName(ref);
        if (name.endsWith(":getExistingActivityIds")) {
          return t.query(
            internal.tonal.historySyncMutations.getExistingActivityIds,
            args as FunctionArgs<typeof internal.tonal.historySyncMutations.getExistingActivityIds>,
          );
        }
        if (name.endsWith(":getAllMovements")) return [];
        throw new Error(`Unexpected query: ${name}`);
      },
      runAction: async (ref: unknown) => {
        const name = referenceName(ref);
        if (name.endsWith(":fetchWorkoutDetail")) return buildDetail(activity.activityId);
        if (name.endsWith(":fetchFormattedSummary")) return { movementSets: [] };
        throw new Error(`Unexpected action: ${name}`);
      },
      runMutation: async (ref: unknown, args: unknown) => {
        const name = referenceName(ref);
        if (name.endsWith(":persistExercisePerformance")) {
          return t.mutation(
            internal.tonal.historySyncMutations.persistExercisePerformance,
            args as FunctionArgs<
              typeof internal.tonal.historySyncMutations.persistExercisePerformance
            >,
          );
        }
        if (name.endsWith(":persistCompletedWorkouts")) {
          return t.mutation(
            internal.tonal.historySyncMutations.persistCompletedWorkouts,
            args as FunctionArgs<
              typeof internal.tonal.historySyncMutations.persistCompletedWorkouts
            >,
          );
        }
        throw new Error(`Unexpected mutation: ${name}`);
      },
    } as unknown as ActionCtx;

    await syncActivitiesAndStrength(ctx, userId, [activity]);

    const state = await t.run(async (dbCtx) => ({
      workout: await dbCtx.db
        .query("completedWorkouts")
        .withIndex("by_userId_activityId", (q) =>
          q.eq("userId", userId).eq("activityId", workout.activityId),
        )
        .unique(),
      performances: await dbCtx.db
        .query("exercisePerformance")
        .withIndex("by_userId_date", (q) => q.eq("userId", userId))
        .collect(),
      records: await dbCtx.db
        .query("personalRecords")
        .withIndex("by_userId_movementId", (q) => q.eq("userId", userId))
        .collect(),
    }));

    expect(state.workout).toMatchObject({ ...workout, performanceSyncComplete: true });
    expect(state.performances.map((row) => row.movementId).sort()).toEqual([
      "bench-press",
      "lat-pulldown",
    ]);
    expect(state.records.map((row) => row.movementId).sort()).toEqual([
      "bench-press",
      "lat-pulldown",
    ]);
  });
});
