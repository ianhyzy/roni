/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  aggregateCrossThreadSearchTelemetry,
  validateSearchTelemetryWindowMs,
} from "./ai/searchTelemetry";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

interface AiRunOverrides {
  runId: string;
  environment: "dev" | "prod";
  createdAt: number;
  retrievalEnabled?: boolean;
  searchHits?: number;
  searchUsed?: boolean;
}

function aiRunRow(userId: Id<"users">, overrides: AiRunOverrides) {
  return {
    userId,
    threadId: "thread-search-telemetry",
    source: "chat" as const,
    totalSteps: 1,
    toolSequence: [],
    retryCount: 0,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    approvalPauses: 0,
    ...overrides,
  };
}

describe("recordRun search telemetry", () => {
  it("persists zero and positive search telemetry values", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(
      internal.aiUsage.recordRun,
      aiRunRow(userId, {
        runId: "zero-search",
        environment: "prod",
        createdAt: 1,
        retrievalEnabled: false,
        searchHits: 0,
        searchUsed: false,
      }),
    );
    await t.mutation(
      internal.aiUsage.recordRun,
      aiRunRow(userId, {
        runId: "positive-search",
        environment: "prod",
        createdAt: 2,
        retrievalEnabled: true,
        searchHits: 3,
        searchUsed: true,
      }),
    );

    const [zeroSearch, positiveSearch] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db
          .query("aiRun")
          .withIndex("by_runId", (q) => q.eq("runId", "zero-search"))
          .unique(),
        ctx.db
          .query("aiRun")
          .withIndex("by_runId", (q) => q.eq("runId", "positive-search"))
          .unique(),
      ]),
    );

    expect(zeroSearch).toMatchObject({ searchHits: 0, searchUsed: false });
    expect(positiveSearch).toMatchObject({ searchHits: 3, searchUsed: true });
  });
});

describe("aggregateCrossThreadSearchTelemetry", () => {
  it("separates legacy and disabled rows from enabled-search rates", () => {
    const result = aggregateCrossThreadSearchTelemetry([
      {},
      { retrievalEnabled: true, searchHits: 3, searchUsed: true },
      { retrievalEnabled: true, searchHits: 0, searchUsed: false },
      { retrievalEnabled: false, searchHits: 0, searchUsed: false },
      { searchHits: 2, searchUsed: true },
    ]);

    expect(result).toMatchObject({
      instrumentedTurns: 4,
      legacyTurns: 1,
      retrievalEnabledTurns: 2,
      retrievalDisabledTurns: 1,
      retrievalUnknownTurns: 1,
      hitTurns: 2,
      usedTurns: 2,
      enabledHitTurns: 1,
      enabledUsedTurns: 1,
      totalHits: 5,
      hitRateEnabled: 0.5,
      usedRateEnabled: 0.5,
      hitRateAll: 0.5,
      usedRateAll: 0.5,
      usedGivenHitRate: 1,
    });
  });

  it("returns zero-safe rates and rejects inconsistent used-without-hit data", () => {
    const result = aggregateCrossThreadSearchTelemetry([
      { retrievalEnabled: true, searchHits: 0, searchUsed: true },
    ]);

    expect(result.hitTurns).toBe(0);
    expect(result.usedTurns).toBe(0);
    expect(result.hitRateEnabled).toBe(0);
    expect(result.usedRateEnabled).toBe(0);
    expect(result.usedGivenHitRate).toBe(0);
  });

  it("treats partial and invalid telemetry as legacy", () => {
    const result = aggregateCrossThreadSearchTelemetry([
      { retrievalEnabled: true, searchHits: 1 },
      { retrievalEnabled: true, searchUsed: false },
      { retrievalEnabled: true, searchHits: -1, searchUsed: false },
      { retrievalEnabled: true, searchHits: Number.NaN, searchUsed: false },
    ]);

    expect(result).toMatchObject({ instrumentedTurns: 0, legacyTurns: 4 });
  });
});

describe("validateSearchTelemetryWindowMs", () => {
  it("defaults to a 14-day observation window", () => {
    expect(validateSearchTelemetryWindowMs()).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it("accepts the maximum 90-day observation window", () => {
    const maximumWindowMs = 90 * 24 * 60 * 60 * 1000;

    expect(validateSearchTelemetryWindowMs(maximumWindowMs)).toBe(maximumWindowMs);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 91 * 24 * 60 * 60 * 1000])(
    "rejects invalid window %s",
    (windowMs) => {
      expect(() => validateSearchTelemetryWindowMs(windowMs)).toThrow(
        "windowMs must be greater than 0 and at most 90 days",
      );
    },
  );
});

describe("getCrossThreadSearchTelemetry", () => {
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
            retrievalEnabled: true,
            searchHits: 2,
            searchUsed: true,
          }),
        );
        await ctx.db.insert(
          "aiRun",
          aiRunRow(userId, {
            runId: "dev-recent",
            environment: "dev",
            createdAt: now - 500,
            retrievalEnabled: true,
            searchHits: 4,
            searchUsed: true,
          }),
        );
        await ctx.db.insert(
          "aiRun",
          aiRunRow(userId, {
            runId: "prod-old",
            environment: "prod",
            createdAt: now - 2_000,
            retrievalEnabled: true,
            searchHits: 5,
            searchUsed: true,
          }),
        );
        await ctx.db.insert(
          "aiRun",
          aiRunRow(userId, {
            runId: "prod-future",
            environment: "prod",
            createdAt: now + 1,
            retrievalEnabled: true,
            searchHits: 6,
            searchUsed: true,
          }),
        );
      });

      const result = await t.query(internal.ai.searchTelemetry.getCrossThreadSearchTelemetry, {
        environment: "prod",
        windowMs: 1_000,
      });

      expect(result).toMatchObject({
        environment: "prod",
        since: now - 1_000,
        until: now,
        analyzedTurns: 1,
        truncated: false,
        instrumentedTurns: 1,
        totalHits: 2,
        hitRateEnabled: 1,
        usedRateEnabled: 1,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("sets truncated and excludes the sentinel row from counts", async () => {
    const now = 100_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const t = convexTest(schema, modules);
      const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
      await t.run(async (ctx) => {
        for (let index = 0; index < 2_001; index += 1) {
          await ctx.db.insert(
            "aiRun",
            aiRunRow(userId, {
              runId: `prod-${index}`,
              environment: "prod",
              createdAt: now - index,
              retrievalEnabled: true,
              searchHits: 1,
              searchUsed: true,
            }),
          );
        }
      });

      const result = await t.query(internal.ai.searchTelemetry.getCrossThreadSearchTelemetry, {
        environment: "prod",
        windowMs: 10_000,
      });

      expect(result).toMatchObject({
        truncated: true,
        analyzedTurns: 2_000,
        instrumentedTurns: 2_000,
        hitTurns: 2_000,
        totalHits: 2_000,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });
});
