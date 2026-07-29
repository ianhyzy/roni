/// <reference types="vite/client" />
import type { ToolCtx } from "@convex-dev/agent";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import type { ToolExecutionOptions } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VolumeStrengthAnalysis } from "../coach/volumeStrengthCorrelation";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { analyzeVolumeStrengthTool } from "./volumeStrengthTool";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? "../ai/" + key.slice(2) : key] = value;
}

const queryRef = makeFunctionReference<
  "query",
  {
    userId: Id<"users">;
    baselineStartDate: string;
    windowStartDate: string;
    windowEndDate: string;
  },
  VolumeStrengthAnalysis
>("ai/volumeStrengthTool:readVolumeStrengthCorrelation");

const ANALYSIS: VolumeStrengthAnalysis = {
  windowWeeks: 26,
  regions: [],
  caveat:
    "This is an observational correlation, not causal MRV, and must not be used as a hard cap on training volume.",
};

function utcDate(weekOffset: number): string {
  const date = new Date("2026-01-05T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + weekOffset * 7);
  return date.toISOString().slice(0, 10);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("analyzeVolumeStrengthTool", () => {
  it("derives userId from the tool context and ignores AI-supplied identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
    const runQuery = vi.fn().mockResolvedValue(ANALYSIS);
    const runMutation = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      runQuery,
      runMutation,
      userId: "context-user",
      threadId: "thread-1",
    } as unknown as ToolCtx;
    const boundTool = { ...analyzeVolumeStrengthTool, ctx };
    const execute = boundTool.execute;
    if (!execute) throw new Error("analyze_volume_strength execute handler missing");

    const result = await execute.call(
      boundTool,
      { userId: "attacker-user" } as never,
      {
        toolCallId: "tool-call-1",
        messages: [],
        experimental_context: { runId: "run-1" },
      } as ToolExecutionOptions,
    );

    expect(result).toEqual(ANALYSIS);
    expect(runQuery).toHaveBeenCalledWith(
      makeFunctionReference("ai/volumeStrengthTool:readVolumeStrengthCorrelation"),
      {
        userId: "context-user",
        baselineStartDate: "2026-01-19",
        windowStartDate: "2026-01-26",
        windowEndDate: "2026-07-26",
      },
    );
  });

  it("rejects execution without a server-provided userId", async () => {
    const runQuery = vi.fn();
    const ctx = {
      runQuery,
      runMutation: vi.fn().mockResolvedValue(undefined),
      threadId: "thread-1",
    } as unknown as ToolCtx;
    const boundTool = { ...analyzeVolumeStrengthTool, ctx };
    const execute = boundTool.execute;
    if (!execute) throw new Error("analyze_volume_strength execute handler missing");

    await expect(
      execute.call(boundTool, {}, {
        toolCallId: "tool-call-2",
        messages: [],
      } as ToolExecutionOptions),
    ).rejects.toThrow("Not authenticated");
    expect(runQuery).not.toHaveBeenCalled();
  });
});

describe("readVolumeStrengthCorrelation", () => {
  it("reads only the requested user's bounded window and resolves movement regions", async () => {
    const t = convexTest(schema, modules);
    const [userId, otherUserId] = await t.run(async (ctx) =>
      Promise.all([ctx.db.insert("users", {}), ctx.db.insert("users", {})]),
    );

    await t.run(async (ctx) => {
      await ctx.db.insert("movements", {
        tonalId: "bench",
        name: "Bench Press",
        shortName: "Bench Press",
        muscleGroups: ["Chest", "Triceps"],
        skillLevel: 1,
        publishState: "published",
        sortOrder: 1,
        onMachine: true,
        inFreeLift: false,
        countReps: true,
        isTwoSided: false,
        isBilateral: true,
        isAlternating: false,
        descriptionHow: "Press",
        descriptionWhy: "Strength",
        bodyRegion: "Upper",
        lastSyncedAt: 1,
      });
      let upper = 100;
      await ctx.db.insert("strengthScoreSnapshots", {
        userId,
        date: utcDate(-1),
        overall: upper,
        upper,
        lower: 100,
        core: 100,
        syncedAt: 1,
      });
      for (let index = 0; index < 8; index++) {
        upper += index + 1;
        await ctx.db.insert("exercisePerformance", {
          userId,
          activityId: `activity-${index}`,
          movementId: "bench",
          date: utcDate(index),
          sets: 3,
          totalReps: 30,
          totalVolume: (index + 1) * 100,
          syncedAt: 1,
        });
        await ctx.db.insert("strengthScoreSnapshots", {
          userId,
          date: utcDate(index),
          overall: upper,
          upper,
          lower: 100,
          core: 100,
          syncedAt: 1,
        });
      }
      await ctx.db.insert("exercisePerformance", {
        userId: otherUserId,
        activityId: "other-activity",
        movementId: "missing",
        date: utcDate(0),
        sets: 3,
        totalReps: 30,
        totalVolume: 999,
        syncedAt: 1,
      });
    });

    const result = await t.query(queryRef, {
      userId,
      baselineStartDate: utcDate(-1),
      windowStartDate: utcDate(0),
      windowEndDate: utcDate(7),
    });

    expect(result.regions[0]).toEqual(
      expect.objectContaining({
        status: "provisional",
        region: "upper",
        weeklyObservationCount: 8,
        strengthObservationCount: 8,
        unmappedMovementCount: 0,
        spearmanRho: 1,
      }),
    );
  });

  it("returns only insufficient results when a bounded read limit is exceeded", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    await t.run(async (ctx) => {
      for (let index = 0; index < 301; index++) {
        await ctx.db.insert("strengthScoreSnapshots", {
          userId,
          date: utcDate(0),
          overall: 100 + index,
          upper: 100 + index,
          lower: 100,
          core: 100,
          syncedAt: index,
        });
      }
    });

    const result = await t.query(queryRef, {
      userId,
      baselineStartDate: utcDate(-1),
      windowStartDate: utcDate(0),
      windowEndDate: utcDate(7),
    });

    expect(result.regions.every((region) => region.status === "insufficient_data")).toBe(true);
    expect(result.caveat).toContain("bounded data limit exceeded");
  });

  it("does not analyze a partial movement catalog when the distinct movement cap is exceeded", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    await t.run(async (ctx) => {
      for (let index = 0; index < 501; index++) {
        await ctx.db.insert("exercisePerformance", {
          userId,
          activityId: `activity-${index}`,
          movementId: `movement-${index}`,
          date: utcDate(0),
          sets: 3,
          totalReps: 30,
          totalVolume: 100,
          syncedAt: index,
        });
      }
    });

    const result = await t.query(queryRef, {
      userId,
      baselineStartDate: utcDate(-1),
      windowStartDate: utcDate(0),
      windowEndDate: utcDate(7),
    });

    expect(result.regions.every((region) => region.status === "insufficient_data")).toBe(true);
    expect(result.caveat).toContain("bounded data limit exceeded");
  });

  it("does not analyze partial performance history when its row cap is exceeded", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    await t.run(async (ctx) => {
      for (let index = 0; index < 3_001; index++) {
        await ctx.db.insert("exercisePerformance", {
          userId,
          activityId: `activity-${index}`,
          movementId: "bench",
          date: utcDate(0),
          sets: 3,
          totalReps: 30,
          totalVolume: 100,
          syncedAt: index,
        });
      }
    });

    const result = await t.query(queryRef, {
      userId,
      baselineStartDate: utcDate(-1),
      windowStartDate: utcDate(0),
      windowEndDate: utcDate(7),
    });

    expect(result.regions.every((region) => region.status === "insufficient_data")).toBe(true);
    expect(result.caveat).toContain("bounded data limit exceeded");
  });
});
