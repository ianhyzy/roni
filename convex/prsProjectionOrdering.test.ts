/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");
const NOW = Date.UTC(2026, 3, 30, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function seedUser(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("userProfiles", {
      userId,
      tonalUserId: "tonal-user",
      tonalToken: "encrypted-token",
      lastActiveAt: NOW,
      lastSyncedActivityDate: "2026-04-30",
      workoutHistoryCachedAt: NOW - 1_000,
      workoutProjectionSourceFetchedAt: NOW - 1_000,
    });
    return userId;
  });
}

async function insertWorkout(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  activityId: string,
  weight: number,
  activityTime?: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("completedWorkouts", {
      userId,
      activityId,
      date: "2026-04-30",
      activityTime,
      title: "Test workout",
      targetArea: "Full Body",
      totalVolume: 1_000,
      totalDuration: 1_800,
      totalWork: 500,
      workoutType: "custom",
      syncedAt: NOW,
      performanceSyncComplete: true,
    });
    await ctx.db.insert("exercisePerformance", {
      userId,
      activityId,
      movementId: "bench",
      date: "2026-04-30",
      sets: 3,
      totalReps: 30,
      avgWeightLbs: weight,
      syncedAt: NOW,
    });
  });
}

describe("workout performance projection ordering", () => {
  it("orders same-day workouts by the full activity timestamp", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    await insertWorkout(t, userId, "newer", 110, "2026-04-30T18:00:00Z");
    await insertWorkout(t, userId, "older", 100, "2026-04-30T08:00:00Z");

    const result = await t.query(internal.prs.getWorkoutPerformanceProjection, { userId });

    expect(result).toMatchObject({ status: "ready", summary: { prs: [{ newWeightLbs: 110 }] } });
  });

  it("falls back when same-day legacy workouts cannot be ordered", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    await insertWorkout(t, userId, "first", 100);
    await insertWorkout(t, userId, "second", 100);

    expect(await t.query(internal.prs.getWorkoutPerformanceProjection, { userId })).toEqual({
      status: "miss",
    });
  });

  it("orders offset timestamps by their actual instant", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    await insertWorkout(t, userId, "earlier", 100, "2026-04-30T09:00:00+02:00");
    await insertWorkout(t, userId, "later", 110, "2026-04-30T08:30:00Z");

    const result = await t.query(internal.prs.getWorkoutPerformanceProjection, { userId });

    expect(result).toMatchObject({ status: "ready", summary: { prs: [{ newWeightLbs: 110 }] } });
  });

  it("falls back when the latest-20 cutoff splits a same-day workout group", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    for (let index = 0; index < 21; index++) {
      await insertWorkout(
        t,
        userId,
        `activity-${index}`,
        100 + index,
        `2026-04-30T${String(index).padStart(2, "0")}:00:00Z`,
      );
    }

    expect(await t.query(internal.prs.getWorkoutPerformanceProjection, { userId })).toEqual({
      status: "miss",
    });
  });
});
