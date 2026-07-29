/// <reference types="vite/client" />
import { describe, expect, test, vi } from "vitest";
import { persistSyncedActivities } from "./historySyncCore";
import type { performanceValidator, workoutValidator } from "./historySyncMutations";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

type WorkoutPayload = typeof workoutValidator.type;
type PerformancePayload = typeof performanceValidator.type;

// Mirrors the cap in historySyncCore.ts. Persisting a large backlog in a single
// mutation overruns Convex's per-transaction limits, which is the root cause of
// the "data refresh ran out of memory" failures for high-volume users (#400).
const MAX_CHUNK = 50;

const TEST_USER_ID = "user-123" as Id<"users">;

function makeCtx() {
  const runMutation = vi.fn(async (_ref: unknown, _args: unknown) => undefined);
  const ctx = { runMutation } as unknown as ActionCtx;
  return { ctx, runMutation };
}

function buildWorkouts(count: number): WorkoutPayload[] {
  return Array.from({ length: count }, (_, i) => ({
    activityId: `activity-${i}`,
    date: "2026-04-25",
    title: `Workout ${i}`,
    targetArea: "Full Body",
    totalVolume: 1000,
    totalDuration: 1800,
    totalWork: 500,
    workoutType: "strength",
  }));
}

function buildPerformances(count: number): PerformancePayload[] {
  return Array.from({ length: count }, (_, i) => ({
    activityId: `activity-${Math.floor(i / 3)}`,
    movementId: `movement-${i}`,
    date: "2026-04-25",
    sets: 3,
    totalReps: 30,
    avgWeightLbs: 100,
  }));
}

/** Collect the per-call array argument for one mutation reference. */
function chunkSizesFor(runMutation: ReturnType<typeof vi.fn>, key: "workouts" | "performances") {
  return runMutation.mock.calls
    .map(([, args]) => (args as Record<string, unknown[]>)[key])
    .filter((arg): arg is unknown[] => Array.isArray(arg))
    .map((arg) => arg.length);
}

describe("persistSyncedActivities", () => {
  test("writes a large workout backlog in chunks no larger than the cap", async () => {
    const { ctx, runMutation } = makeCtx();

    await persistSyncedActivities(ctx, TEST_USER_ID, {
      workouts: buildWorkouts(120),
      performances: [],
    });

    const sizes = chunkSizesFor(runMutation, "workouts");
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_CHUNK);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(120);
  });

  test("writes a large performance backlog in chunks no larger than the cap", async () => {
    const { ctx, runMutation } = makeCtx();

    await persistSyncedActivities(ctx, TEST_USER_ID, {
      workouts: [],
      performances: buildPerformances(250),
    });

    const sizes = chunkSizesFor(runMutation, "performances");
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_CHUNK);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250);
  });

  test("preserves order and persists every row exactly once across chunks", async () => {
    const { ctx, runMutation } = makeCtx();
    const performances = buildPerformances(130);

    await persistSyncedActivities(ctx, TEST_USER_ID, { workouts: [], performances });

    const persisted = runMutation.mock.calls
      .map(([, args]) => (args as { performances?: PerformancePayload[] }).performances)
      .filter((arg): arg is PerformancePayload[] => Array.isArray(arg))
      .flat();
    expect(persisted).toEqual(performances);
  });

  test("issues no writes when there is nothing to persist", async () => {
    const { ctx, runMutation } = makeCtx();

    await persistSyncedActivities(ctx, TEST_USER_ID, { workouts: [], performances: [] });

    expect(runMutation).not.toHaveBeenCalled();
  });

  test("writes a single chunk without splitting when under the cap", async () => {
    const { ctx, runMutation } = makeCtx();

    await persistSyncedActivities(ctx, TEST_USER_ID, {
      workouts: buildWorkouts(10),
      performances: [],
    });

    expect(chunkSizesFor(runMutation, "workouts")).toEqual([10]);
  });

  test("does not mark workouts complete when a later performance chunk fails", async () => {
    let performanceChunks = 0;
    const runMutation = vi.fn(async (_ref: unknown, args: unknown) => {
      if ((args as { performances?: PerformancePayload[] }).performances) {
        performanceChunks++;
        if (performanceChunks === 2) throw new Error("performance persistence failed");
      }
    });
    const ctx = { runMutation } as unknown as ActionCtx;

    await expect(
      persistSyncedActivities(ctx, TEST_USER_ID, {
        workouts: buildWorkouts(1),
        performances: buildPerformances(MAX_CHUNK + 1),
      }),
    ).rejects.toThrow("performance persistence failed");

    expect(chunkSizesFor(runMutation, "performances")).toEqual([MAX_CHUNK, 1]);
    expect(chunkSizesFor(runMutation, "workouts")).toEqual([]);
  });
});
