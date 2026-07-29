/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { type FunctionArgs, getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import schema from "../schema";
import { syncActivitiesAndStrength } from "./historySyncCore";
import type { Activity } from "./types";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? "../tonal/" + key.slice(2) : key] = value;
}

const ACTIVITY_TIME = "2026-06-01T12:00:00Z";
const ACTIVITY_DATE = "2026-06-01";

function workoutPayload(activityId: string) {
  return {
    activityId,
    date: ACTIVITY_DATE,
    activityTime: ACTIVITY_TIME,
    title: "Upper Body",
    targetArea: "Upper Body",
    totalVolume: 1_200,
    totalDuration: 1_800,
    totalWork: 800,
    workoutType: "strength",
    tonalWorkoutId: `workout-${activityId}`,
  };
}

function activity(activityId: string): Activity {
  const workout = workoutPayload(activityId);
  return {
    activityId,
    userId: "tonal-user",
    activityTime: ACTIVITY_TIME,
    activityType: "strength",
    workoutPreview: {
      activityId,
      workoutId: workout.tonalWorkoutId,
      workoutTitle: workout.title,
      programName: "",
      coachName: "",
      level: "",
      targetArea: workout.targetArea,
      isGuidedWorkout: false,
      workoutType: workout.workoutType,
      beginTime: ACTIVITY_TIME,
      totalDuration: workout.totalDuration,
      totalVolume: workout.totalVolume,
      totalWork: workout.totalWork,
      totalAchievements: 0,
      activityType: "strength",
    },
  };
}

describe("history sync activity timestamps", () => {
  test("persists activity time for new and partial workout rows", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    await t.mutation(internal.tonal.historySyncMutations.persistCompletedWorkouts, {
      userId,
      workouts: [workoutPayload("new")],
    });
    await t.run((ctx) =>
      ctx.db.insert("completedWorkouts", {
        userId,
        ...workoutPayload("partial"),
        activityTime: undefined,
        syncedAt: 1,
      }),
    );
    await t.mutation(internal.tonal.historySyncMutations.persistCompletedWorkouts, {
      userId,
      workouts: [workoutPayload("partial")],
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("completedWorkouts")
        .withIndex("by_userId_date", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.activityTime === ACTIVITY_TIME)).toBe(true);
    expect(rows.every((row) => row.performanceSyncComplete === true)).toBe(true);
  });

  test("refreshes finalized legacy rows without refetching workout detail", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const sourceActivity = activity("finalized-legacy");
    await t.run((ctx) =>
      ctx.db.insert("completedWorkouts", {
        userId,
        ...workoutPayload(sourceActivity.activityId),
        activityTime: undefined,
        syncedAt: 1,
        performanceSyncComplete: true,
      }),
    );
    const runAction = vi.fn();
    const ctx = {
      runQuery: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
        if (!getFunctionName(ref).endsWith(":getExistingActivityIds")) {
          throw new Error(`Unexpected query: ${getFunctionName(ref)}`);
        }
        return t.query(
          internal.tonal.historySyncMutations.getExistingActivityIds,
          args as FunctionArgs<typeof internal.tonal.historySyncMutations.getExistingActivityIds>,
        );
      },
      runMutation: (ref: Parameters<typeof getFunctionName>[0], args: unknown) => {
        if (!getFunctionName(ref).endsWith(":refreshCompletedWorkoutMetadata")) {
          throw new Error(`Unexpected mutation: ${getFunctionName(ref)}`);
        }
        return t.mutation(
          internal.tonal.historySyncMutations.refreshCompletedWorkoutMetadata,
          args as FunctionArgs<
            typeof internal.tonal.historySyncMutations.refreshCompletedWorkoutMetadata
          >,
        );
      },
      runAction,
    } as unknown as ActionCtx;

    const result = await syncActivitiesAndStrength(ctx, userId, [sourceActivity]);
    const persisted = await t.run((dbCtx) =>
      dbCtx.db
        .query("completedWorkouts")
        .withIndex("by_userId_activityId", (q) =>
          q.eq("userId", userId).eq("activityId", sourceActivity.activityId),
        )
        .unique(),
    );

    expect(result).toEqual({ synced: 0, remaining: 0 });
    expect(persisted?.activityTime).toBe(ACTIVITY_TIME);
    expect(runAction).not.toHaveBeenCalled();
  });
});
