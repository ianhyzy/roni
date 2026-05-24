/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
  aggregateDetailToSessions,
  getPerMovementHistory,
  type PerMovementHistoryEntry,
} from "./progressiveOverload";
import schema from "./schema";
import { TonalSessionExpiredError } from "./tonal/tokenRetry";
import type { WorkoutActivityDetail } from "./tonal/types";

const modules = import.meta.glob("./**/*.*s");

type GetPerMovementHistoryHandler = (
  ctx: ActionCtx,
  args: { userId: Id<"users">; maxActivities?: number },
) => Promise<PerMovementHistoryEntry[]>;

const getPerMovementHistoryHandler = (
  getPerMovementHistory as unknown as { _handler: GetPerMovementHistoryHandler }
)._handler;

function makeDetail(overrides: Partial<WorkoutActivityDetail> = {}): WorkoutActivityDetail {
  return {
    id: "d1",
    userId: "u1",
    workoutId: "w1",
    workoutType: "custom",
    timezone: "America/New_York",
    beginTime: "2026-03-10T10:00:00Z",
    endTime: "2026-03-10T10:45:00Z",
    totalDuration: 2700,
    activeDuration: 2400,
    restDuration: 300,
    totalMovements: 2,
    totalSets: 4,
    totalReps: 40,
    totalVolume: 5000,
    totalConcentricWork: 3000,
    percentCompleted: 100,
    ...overrides,
  };
}

describe("aggregateDetailToSessions", () => {
  it("groups sets by movementId and computes reps/set counts", () => {
    const detail = makeDetail({
      workoutSetActivity: [
        {
          id: "s1",
          movementId: "m1",
          prescribedReps: 10,
          repetition: 10,
          repetitionTotal: 3,
          blockNumber: 1,
          spotter: false,
          eccentric: false,
          chains: false,
          flex: false,
          warmUp: false,
          beginTime: "2026-03-10T10:00:00Z",
          sideNumber: 0,
        },
        {
          id: "s2",
          movementId: "m1",
          prescribedReps: 10,
          repetition: 10,
          repetitionTotal: 3,
          blockNumber: 1,
          spotter: false,
          eccentric: false,
          chains: false,
          flex: false,
          warmUp: false,
          beginTime: "2026-03-10T10:02:00Z",
          sideNumber: 0,
        },
        {
          id: "s3",
          movementId: "m2",
          prescribedReps: 8,
          repetition: 8,
          repetitionTotal: 2,
          blockNumber: 2,
          spotter: false,
          eccentric: false,
          chains: false,
          flex: false,
          warmUp: false,
          beginTime: "2026-03-10T10:05:00Z",
          sideNumber: 0,
        },
      ],
    });

    const result = aggregateDetailToSessions(detail);

    expect(result.size).toBe(2);

    const m1 = result.get("m1");
    expect(m1).toBeDefined();
    expect(m1!.sets).toBe(2);
    expect(m1!.totalReps).toBe(20);
    expect(m1!.repsPerSet).toBe(10);
    expect(m1!.sessionDate).toBe("2026-03-10");

    const m2 = result.get("m2");
    expect(m2).toBeDefined();
    expect(m2!.sets).toBe(1);
    expect(m2!.totalReps).toBe(8);
  });

  it("returns empty map when workoutSetActivity is undefined", () => {
    const detail = makeDetail({ workoutSetActivity: undefined });

    const result = aggregateDetailToSessions(detail);

    expect(result.size).toBe(0);
  });

  it("returns empty map when workoutSetActivity is an empty array", () => {
    const detail = makeDetail({ workoutSetActivity: [] });

    const result = aggregateDetailToSessions(detail);

    expect(result.size).toBe(0);
  });

  it("computes avgWeightLbs from per-set avgWeight", () => {
    const detail = makeDetail({
      workoutSetActivity: [
        {
          id: "s1",
          movementId: "m1",
          prescribedReps: 10,
          repetition: 8,
          repetitionTotal: 2,
          blockNumber: 1,
          spotter: false,
          eccentric: false,
          chains: false,
          flex: false,
          warmUp: false,
          beginTime: "2026-03-10T10:00:00Z",
          sideNumber: 0,
          avgWeight: 50,
        },
        {
          id: "s2",
          movementId: "m1",
          prescribedReps: 10,
          repetition: 12,
          repetitionTotal: 2,
          blockNumber: 1,
          spotter: false,
          eccentric: false,
          chains: false,
          flex: false,
          warmUp: false,
          beginTime: "2026-03-10T10:02:00Z",
          sideNumber: 0,
          avgWeight: 60,
        },
      ],
    });

    const result = aggregateDetailToSessions(detail);

    const m1 = result.get("m1");
    // Weighted average: (50*8 + 60*12) / 20 = 56
    expect(m1!.avgWeightLbs).toBe(56);
  });

  it("doubles avgWeight for StraightBar movements", () => {
    const detail = makeDetail({
      workoutSetActivity: [
        {
          id: "s1",
          movementId: "bar1",
          prescribedReps: 10,
          repetition: 10,
          repetitionTotal: 1,
          blockNumber: 1,
          spotter: false,
          eccentric: false,
          chains: false,
          flex: false,
          warmUp: false,
          beginTime: "2026-03-10T10:00:00Z",
          sideNumber: 0,
          avgWeight: 47,
        },
      ],
    });

    const straightBarIds = new Set(["bar1"]);
    const result = aggregateDetailToSessions(detail, straightBarIds);

    const bar1 = result.get("bar1");
    expect(bar1!.avgWeightLbs).toBe(94);
  });

  it("omits avgWeightLbs when sets have no avgWeight", () => {
    const detail = makeDetail({
      workoutSetActivity: [
        {
          id: "s1",
          movementId: "m1",
          prescribedReps: 10,
          repetition: 10,
          repetitionTotal: 1,
          blockNumber: 1,
          spotter: false,
          eccentric: false,
          chains: false,
          flex: false,
          warmUp: false,
          beginTime: "2026-03-10T10:00:00Z",
          sideNumber: 0,
        },
      ],
    });

    const result = aggregateDetailToSessions(detail);

    const m1 = result.get("m1");
    expect(m1!.avgWeightLbs).toBeUndefined();
  });
});

describe("getPerMovementHistory Tonal API resilience", () => {
  it("returns empty array when user has no Tonal profile (API unavailable)", async () => {
    // When fetchWorkoutHistory throws because there is no Tonal profile in the DB
    // (equivalent to a network/auth-setup failure), getPerMovementHistory must
    // return [] rather than propagating the error to the caller.
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    const result = await t.action(internal.progressiveOverload.getPerMovementHistory, { userId });

    expect(result).toEqual([]);
  });

  it("rethrows session-expired errors so reconnect prompts are not masked", async () => {
    // fetchWorkoutHistory swallows TonalSessionExpiredError and returns [].
    // fetchWorkoutHistoryOrEmpty detects expiry by checking profile.tonalTokenExpiresAt === 0.
    const ctx = {
      runAction: vi.fn().mockResolvedValue([]),
      runQuery: vi.fn().mockResolvedValue({ tonalTokenExpiresAt: 0 }),
    } as unknown as ActionCtx;

    await expect(
      getPerMovementHistoryHandler(ctx, {
        userId: "test-user-123" as Id<"users">,
        maxActivities: 20,
      }),
    ).rejects.toBeInstanceOf(TonalSessionExpiredError);
  });

  it("rethrows session-expired errors from detail fetches", async () => {
    const ctx = {
      runAction: vi
        .fn()
        .mockResolvedValueOnce([{ activityId: "activity-1", activityTime: "2026-03-10T10:00:00Z" }])
        .mockRejectedValueOnce(new TonalSessionExpiredError()),
      runQuery: vi.fn().mockResolvedValue([]),
    } as unknown as ActionCtx;

    await expect(
      getPerMovementHistoryHandler(ctx, {
        userId: "test-user-123" as Id<"users">,
        maxActivities: 20,
      }),
    ).rejects.toBeInstanceOf(TonalSessionExpiredError);
    expect(ctx.runAction).toHaveBeenCalledTimes(2);
  });
});
