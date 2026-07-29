/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  WORKOUT_PERFORMANCE_PER_ACTIVITY_ROW_LIMIT,
  WORKOUT_PERFORMANCE_PROJECTION_MOVEMENT_LIMIT,
  WORKOUT_PERFORMANCE_PROJECTION_ROW_LIMIT,
} from "./prs";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const NOW = Date.UTC(2026, 3, 30, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

type CompletedWorkoutInsert = Omit<Doc<"completedWorkouts">, "_id" | "_creationTime">;

function completedWorkout(
  userId: Id<"users">,
  activityId: string,
  date: string,
  activityTime?: string,
  complete: boolean = true,
): CompletedWorkoutInsert {
  const workout: CompletedWorkoutInsert = {
    userId,
    activityId,
    date,
    activityTime,
    title: "Test workout",
    targetArea: "Full Body",
    totalVolume: 1_000,
    totalDuration: 1_800,
    totalWork: 500,
    workoutType: "custom",
    syncedAt: 1,
    performanceSyncComplete: complete ? true : undefined,
  };
  return workout;
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  lastSyncedActivityDate: string,
  workoutHistoryCachedAt: number = NOW - 1_000,
  workoutProjectionSourceFetchedAt: number = workoutHistoryCachedAt,
) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("userProfiles", {
      userId,
      tonalUserId: "tonal-user",
      tonalToken: "encrypted-token",
      lastActiveAt: NOW,
      lastSyncedActivityDate,
      workoutHistoryCachedAt,
      workoutProjectionSourceFetchedAt,
    });
    return userId;
  });
}

function performanceRow(
  userId: Id<"users">,
  activityId: string,
  movementId: string,
  date: string,
  avgWeightLbs?: number,
) {
  return {
    userId,
    activityId,
    movementId,
    date,
    sets: 3,
    totalReps: 30,
    avgWeightLbs,
    syncedAt: 1,
  };
}

describe("getWorkoutPerformanceProjection", () => {
  it("uses only the latest 20 finalized workouts and resolves movement names", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "2026-04-30");
    await t.run(async (ctx) => {
      await ctx.db.insert("movements", {
        tonalId: "bar-bench",
        name: "Bar Bench Press",
        shortName: "Bar Bench Press",
        muscleGroups: ["Chest"],
        skillLevel: 1,
        publishState: "published",
        sortOrder: 1,
        onMachine: true,
        inFreeLift: false,
        countReps: true,
        isTwoSided: false,
        isBilateral: true,
        isAlternating: false,
        descriptionHow: "",
        descriptionWhy: "",
        lastSyncedAt: 1,
      });
      for (let index = 0; index < 21; index++) {
        const activityId = `activity-${index}`;
        const date = `2026-04-${String(30 - index).padStart(2, "0")}`;
        const avgWeightLbs = index === 0 ? 100 : index === 20 ? 200 : 90;
        await ctx.db.insert("completedWorkouts", completedWorkout(userId, activityId, date));
        await ctx.db.insert(
          "exercisePerformance",
          performanceRow(userId, activityId, "bar-bench", date, avgWeightLbs),
        );
      }
    });

    const result = await t.query(internal.prs.getWorkoutPerformanceProjection, { userId });

    expect(result).toMatchObject({
      status: "ready",
      summary: {
        prs: [{ movementName: "Bar Bench Press", newWeightLbs: 100, previousBestLbs: 90 }],
      },
    });
  });

  it("returns miss when no completed workouts exist", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "2026-04-30");

    const result = await t.query(internal.prs.getWorkoutPerformanceProjection, { userId });

    expect(result).toEqual({ status: "miss" });
  });

  it.each([
    { complete: false, avgWeightLbs: 100, label: "unfinished" },
    { complete: true, avgWeightLbs: undefined, label: "weightless" },
    { complete: true, avgWeightLbs: 0, label: "zero-weight" },
  ])("returns miss for $label projection data", async ({ complete, avgWeightLbs }) => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "2026-04-15");
    await t.run(async (ctx) => {
      await ctx.db.insert(
        "completedWorkouts",
        completedWorkout(userId, "activity", "2026-04-15", undefined, complete),
      );
      await ctx.db.insert(
        "exercisePerformance",
        performanceRow(userId, "activity", "bench", "2026-04-15", avgWeightLbs),
      );
    });

    const result = await t.query(internal.prs.getWorkoutPerformanceProjection, { userId });

    expect(result).toEqual({ status: "miss" });
  });

  it("ignores weightless rows when weighted projection data remains", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "2026-04-15");
    await t.run(async (ctx) => {
      await ctx.db.insert("completedWorkouts", completedWorkout(userId, "activity", "2026-04-15"));
      await ctx.db.insert(
        "exercisePerformance",
        performanceRow(userId, "activity", "bodyweight", "2026-04-15"),
      );
      await ctx.db.insert(
        "exercisePerformance",
        performanceRow(userId, "activity", "bench", "2026-04-15", 100),
      );
    });

    expect(await t.query(internal.prs.getWorkoutPerformanceProjection, { userId })).toMatchObject({
      status: "ready",
    });
  });

  it("returns limit_exceeded when one workout exceeds its row cap", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "2026-04-15");
    await t.run(async (ctx) => {
      await ctx.db.insert("completedWorkouts", completedWorkout(userId, "activity", "2026-04-15"));
      for (let index = 0; index <= WORKOUT_PERFORMANCE_PER_ACTIVITY_ROW_LIMIT; index++) {
        await ctx.db.insert(
          "exercisePerformance",
          performanceRow(userId, "activity", `movement-${index}`, "2026-04-15", 100),
        );
      }
    });

    const result = await t.query(internal.prs.getWorkoutPerformanceProjection, { userId });

    expect(result).toEqual({ status: "limit_exceeded" });
  });

  it("returns limit_exceeded when bounded workout rows exceed the total row cap", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "2026-04-30");
    await t.run(async (ctx) => {
      const workoutCount =
        Math.floor(
          WORKOUT_PERFORMANCE_PROJECTION_ROW_LIMIT / WORKOUT_PERFORMANCE_PER_ACTIVITY_ROW_LIMIT,
        ) + 1;

      for (let workoutIndex = 0; workoutIndex < workoutCount; workoutIndex++) {
        const activityId = `activity-${workoutIndex}`;
        const date = `2026-04-${String(30 - workoutIndex).padStart(2, "0")}`;
        await ctx.db.insert("completedWorkouts", completedWorkout(userId, activityId, date));
        for (
          let movementIndex = 0;
          movementIndex < WORKOUT_PERFORMANCE_PER_ACTIVITY_ROW_LIMIT;
          movementIndex++
        ) {
          await ctx.db.insert(
            "exercisePerformance",
            performanceRow(userId, activityId, `movement-${movementIndex}`, date, 100),
          );
        }
      }
    });

    const result = await t.query(internal.prs.getWorkoutPerformanceProjection, { userId });

    expect(result).toEqual({ status: "limit_exceeded" });
  });

  it("returns limit_exceeded before resolving too many movement names", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "2026-04-15");
    await t.run(async (ctx) => {
      for (const [activityId, count] of [
        ["activity-a", 101],
        ["activity-b", WORKOUT_PERFORMANCE_PROJECTION_MOVEMENT_LIMIT - 100],
      ] as const) {
        await ctx.db.insert(
          "completedWorkouts",
          completedWorkout(
            userId,
            activityId,
            activityId === "activity-a" ? "2026-04-15" : "2026-04-14",
          ),
        );
        for (let index = 0; index < count; index++) {
          await ctx.db.insert(
            "exercisePerformance",
            performanceRow(
              userId,
              activityId,
              `${activityId}-movement-${index}`,
              activityId === "activity-a" ? "2026-04-15" : "2026-04-14",
              100,
            ),
          );
        }
      }
    });

    expect(WORKOUT_PERFORMANCE_PROJECTION_MOVEMENT_LIMIT).toBeLessThan(
      WORKOUT_PERFORMANCE_PROJECTION_ROW_LIMIT,
    );
    const result = await t.query(internal.prs.getWorkoutPerformanceProjection, { userId });

    expect(result).toEqual({ status: "limit_exceeded" });
  });
});
