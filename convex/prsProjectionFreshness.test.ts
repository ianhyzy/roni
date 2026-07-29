/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { CACHE_TTLS } from "./tonal/cache";

const modules = import.meta.glob("./**/*.*s");
const NOW = Date.UTC(2026, 3, 30, 12);
const WORKOUT_DATE = "2026-04-15";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function seedProjection(
  t: ReturnType<typeof convexTest>,
  lastSyncedActivityDate: string,
  sourceFetchedAt: number,
  workoutHistoryCachedAt: number = sourceFetchedAt,
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
      workoutProjectionSourceFetchedAt: sourceFetchedAt,
    });
    await ctx.db.insert("completedWorkouts", {
      userId,
      activityId: "activity",
      date: WORKOUT_DATE,
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
      activityId: "activity",
      movementId: "bench",
      date: WORKOUT_DATE,
      sets: 3,
      totalReps: 30,
      avgWeightLbs: 100,
      syncedAt: NOW,
    });
    return userId;
  });
}

describe("workout performance projection freshness", () => {
  it.each([
    { sourceFetchedAt: NOW - CACHE_TTLS.workoutHistory, label: "reaches the bound" },
    { sourceFetchedAt: NOW + 1, label: "is in the future" },
  ])("falls back when source verification $label", async ({ sourceFetchedAt }) => {
    const t = convexTest(schema, modules);
    const userId = await seedProjection(t, WORKOUT_DATE, sourceFetchedAt);

    expect(await t.query(internal.prs.getWorkoutPerformanceProjection, { userId })).toEqual({
      status: "miss",
    });
  });

  it("falls back when the latest completed date is not the synced high-water mark", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedProjection(t, "2026-04-14", NOW - 1_000);

    expect(await t.query(internal.prs.getWorkoutPerformanceProjection, { userId })).toEqual({
      status: "miss",
    });
  });

  it("does not treat an upstream refresh as successful projection persistence", async () => {
    const t = convexTest(schema, modules);
    const staleVerification = NOW - CACHE_TTLS.workoutHistory - 1;
    const userId = await seedProjection(t, WORKOUT_DATE, staleVerification, NOW);

    expect(await t.query(internal.prs.getWorkoutPerformanceProjection, { userId })).toEqual({
      status: "miss",
    });
  });
});
