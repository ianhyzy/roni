/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  aggregateMemoryFactSearchTelemetry,
  type MemoryFactTelemetryRow,
} from "./memoryFactTelemetry";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../ai/${key.slice(2)}` : key] = value;
}

function aiRunRow(
  userId: Id<"users">,
  overrides: {
    runId: string;
    environment: "dev" | "prod";
    createdAt: number;
    memoryFactsInjected?: number;
  },
) {
  return {
    userId,
    threadId: "thread-memory-telemetry",
    source: "chat" as const,
    finishReason: "stop" as const,
    totalSteps: 1,
    toolSequence: ["search_exercises", "create_workout"],
    retryCount: 0,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    approvalPauses: 0,
    ...overrides,
  };
}

function row(overrides: Partial<MemoryFactTelemetryRow> = {}): MemoryFactTelemetryRow {
  return {
    userId: "user-1",
    source: "chat",
    finishReason: "stop",
    toolSequence: ["search_exercises", "create_workout"],
    memoryFactsInjected: 0,
    ...overrides,
  };
}

describe("aggregateMemoryFactSearchTelemetry", () => {
  it("compares paired-user exercise search calls before and after facts", () => {
    const summary = aggregateMemoryFactSearchTelemetry([
      row({ toolSequence: ["search_exercises", "search_exercises", "create_workout"] }),
      row({ memoryFactsInjected: 2, toolSequence: ["search_exercises", "create_workout"] }),
    ]);

    expect(summary.pairedUsers).toBe(1);
    expect(summary.pairedWithoutFacts).toMatchObject({
      eligibleTurns: 1,
      searchExerciseCalls: 2,
      repeatedSearchTurns: 1,
      callsPerEligibleTurn: 2,
    });
    expect(summary.pairedWithFacts).toMatchObject({
      eligibleTurns: 1,
      searchExerciseCalls: 1,
      repeatedSearchTurns: 0,
      callsPerEligibleTurn: 1,
    });
    expect(summary.absolutePairedCallsPerTurnDelta).toBe(-1);
    expect(summary.relativePairedCallsPerTurnChange).toBe(-0.5);
  });

  it("separates legacy rows and excludes failed, approval, and non-selection turns", () => {
    const summary = aggregateMemoryFactSearchTelemetry([
      row({ memoryFactsInjected: undefined }),
      row({ finishReason: "error" }),
      row({ terminalErrorClass: "byok_quota_exceeded" }),
      row({ source: "approval_continuation" }),
      row({ toolSequence: ["get_strength_scores"] }),
    ]);

    expect(summary.legacyEligibleTurns).toBe(1);
    expect(summary.withoutFacts.eligibleTurns).toBe(0);
    expect(summary.withFacts.eligibleTurns).toBe(0);
    expect(summary.pairedUsers).toBe(0);
  });

  it("reports a null relative change when the paired baseline has no searches", () => {
    const summary = aggregateMemoryFactSearchTelemetry([
      row({ toolSequence: ["create_workout"] }),
      row({ memoryFactsInjected: 1, toolSequence: ["search_exercises", "create_workout"] }),
    ]);

    expect(summary.pairedUsers).toBe(1);
    expect(summary.absolutePairedCallsPerTurnDelta).toBe(1);
    expect(summary.relativePairedCallsPerTurnChange).toBeNull();
  });
});

describe("getMemoryFactSearchTelemetry", () => {
  it("filters by environment and indexed time window", async () => {
    const now = 100_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const t = convexTest(schema, modules);
      const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
      await t.run(async (ctx) => {
        await ctx.db.insert(
          "aiRun",
          aiRunRow(userId, {
            runId: "prod-recent",
            environment: "prod",
            createdAt: now - 500,
            memoryFactsInjected: 2,
          }),
        );
        await ctx.db.insert(
          "aiRun",
          aiRunRow(userId, {
            runId: "dev-recent",
            environment: "dev",
            createdAt: now - 500,
            memoryFactsInjected: 2,
          }),
        );
        await ctx.db.insert(
          "aiRun",
          aiRunRow(userId, {
            runId: "prod-old",
            environment: "prod",
            createdAt: now - 2_000,
            memoryFactsInjected: 0,
          }),
        );
        await ctx.db.insert(
          "aiRun",
          aiRunRow(userId, {
            runId: "prod-future",
            environment: "prod",
            createdAt: now + 1,
            memoryFactsInjected: 0,
          }),
        );
      });

      const result = await t.query(internal.ai.memoryFactTelemetry.getMemoryFactSearchTelemetry, {
        environment: "prod",
        windowMs: 1_000,
      });

      expect(result).toMatchObject({
        environment: "prod",
        since: now - 1_000,
        until: now,
        analyzedTurns: 1,
        truncated: false,
        legacyEligibleTurns: 0,
        pairedUsers: 0,
        withFacts: {
          eligibleTurns: 1,
          searchExerciseCalls: 1,
          turnsWithSearch: 1,
        },
        withoutFacts: { eligibleTurns: 0 },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
