/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import schema from "../schema";
import { encryptFitbitSecret } from "./config";
import { buildFitbitSyncFilters, fitbitSyncStartDate, revokeFitbitTokenWithRetry } from "./sync";
import { resolveLostFitbitTokenRefresh } from "./tokenRevocation";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../fitbit/${key.slice(2)}` : key] = value;
}

describe("buildFitbitSyncFilters", () => {
  it("uses the documented civil field for each Google Health data type", () => {
    expect(buildFitbitSyncFilters("2026-07-01")).toEqual({
      exercise: 'exercise.interval.civil_start_time >= "2026-07-01"',
      sleep: 'sleep.interval.civil_end_time >= "2026-07-01"',
      "daily-resting-heart-rate": 'daily_resting_heart_rate.date >= "2026-07-01"',
      "daily-heart-rate-variability": 'daily_heart_rate_variability.date >= "2026-07-01"',
    });
  });

  it("treats a 30-day window as today plus the previous 29 civil dates", () => {
    expect(fitbitSyncStartDate(Date.parse("2026-07-30T12:00:00Z"), 30)).toBe("2026-07-01");
    expect(fitbitSyncStartDate(Date.parse("2026-07-30T12:00:00Z"), 1)).toBe("2026-07-30");
  });
});

describe("revokeFitbitTokenWithRetry", () => {
  it("honors Retry-After before a successful retry", async () => {
    const delays: number[] = [];
    let calls = 0;

    const result = await revokeFitbitTokenWithRetry("refresh-token", {
      fetcher: async () => {
        calls += 1;
        return calls === 1
          ? new Response(null, { status: 429, headers: { "Retry-After": "2" } })
          : new Response(null, { status: 200 });
      },
      random: () => 0,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(result).toBe(true);
    expect(calls).toBe(2);
    expect(delays).toEqual([2000]);
  });

  it("honors an HTTP-date Retry-After value", async () => {
    const delays: number[] = [];
    const now = Date.parse("2026-07-29T12:00:00Z");
    let calls = 0;

    const result = await revokeFitbitTokenWithRetry("refresh-token", {
      fetcher: async () => {
        calls += 1;
        return calls === 1
          ? new Response(null, {
              status: 503,
              headers: { "Retry-After": new Date(now + 3_000).toUTCString() },
            })
          : new Response(null, { status: 200 });
      },
      now: () => now,
      random: () => 0,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(result).toBe(true);
    expect(delays).toEqual([3000]);
  });

  it("backs off after a network failure before retrying", async () => {
    const delays: number[] = [];
    let calls = 0;

    const result = await revokeFitbitTokenWithRetry("refresh-token", {
      fetcher: async () => {
        calls += 1;
        if (calls === 1) throw new Error("network unavailable");
        return new Response(null, { status: 200 });
      },
      random: () => 1,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(result).toBe(true);
    expect(calls).toBe(2);
    expect(delays).toEqual([250]);
  });

  it("uses jittered exponential delays for transient failures", async () => {
    const delays: number[] = [];

    const result = await revokeFitbitTokenWithRetry("refresh-token", {
      fetcher: async () => new Response(null, { status: 503 }),
      random: () => 0,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(result).toBe(false);
    expect(delays).toEqual([125, 250]);
  });

  it("bounds excessive Retry-After values", async () => {
    const delays: number[] = [];
    let calls = 0;

    await revokeFitbitTokenWithRetry("refresh-token", {
      fetcher: async () => {
        calls += 1;
        return calls === 1
          ? new Response(null, { status: 503, headers: { "Retry-After": "600" } })
          : new Response(null, { status: 400 });
      },
      random: () => 0,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(delays).toEqual([5000]);
  });
});

describe("refresh and disconnect coordination", () => {
  it("uses the winning same-generation access token without revoking the discarded refresh", async () => {
    const originalEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
    const userId = "user-1" as Id<"users">;
    const winningAccessToken = "winning-access-token";
    const runQuery = vi.fn(async () => ({
      status: "active" as const,
      generation: "generation-1",
      accessTokenEncrypted: await encryptFitbitSecret(winningAccessToken),
    }));
    const revoke = vi.fn(async () => true);
    const ctx = { runQuery } as unknown as Pick<ActionCtx, "runQuery">;

    try {
      await expect(
        resolveLostFitbitTokenRefresh(ctx, {
          userId,
          generation: "generation-1",
          discardedRefreshToken: "discarded-refresh-token",
          revoke,
        }),
      ).resolves.toBe(winningAccessToken);
      expect(revoke).not.toHaveBeenCalled();
    } finally {
      if (originalEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
    }
  });

  it("revokes a rotated token discarded after same-generation disconnect wins", async () => {
    const userId = "user-1" as Id<"users">;
    const runQuery = vi.fn(async () => ({
      status: "disconnected" as const,
      generation: "generation-1",
    }));
    const revoke = vi.fn(async () => true);
    const ctx = { runQuery } as unknown as Pick<ActionCtx, "runQuery">;

    await expect(
      resolveLostFitbitTokenRefresh(ctx, {
        userId,
        generation: "generation-1",
        discardedRefreshToken: "refresh-rotated",
        revoke,
      }),
    ).rejects.toThrow("Fitbit connection changed during sync");

    expect(revoke).toHaveBeenCalledWith("refresh-rotated");
  });

  it("throws and logs only safe identifiers when discarded-token revocation fails", async () => {
    const userId = "user-1" as Id<"users">;
    const runQuery = vi.fn(async () => ({
      status: "disconnected" as const,
      generation: "generation-1",
    }));
    const revoke = vi.fn(async () => false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = { runQuery } as unknown as Pick<ActionCtx, "runQuery">;

    try {
      await expect(
        resolveLostFitbitTokenRefresh(ctx, {
          userId,
          generation: "generation-1",
          discardedRefreshToken: "discarded-refresh-token",
          revoke,
        }),
      ).rejects.toThrow("Fitbit connection changed during sync");

      expect(consoleError).toHaveBeenCalledWith(
        "[fitbitSync] failed to revoke a discarded rotated token",
        { userId, generation: "generation-1" },
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not revoke an old refresh result after a new connection generation wins", async () => {
    const userId = "user-1" as Id<"users">;
    const runQuery = vi.fn(async () => ({
      status: "active" as const,
      generation: "generation-2",
    }));
    const revoke = vi.fn(async () => true);
    const ctx = { runQuery } as unknown as Pick<ActionCtx, "runQuery">;

    await expect(
      resolveLostFitbitTokenRefresh(ctx, {
        userId,
        generation: "generation-1",
        discardedRefreshToken: "refresh-generation-1",
        revoke,
      }),
    ).rejects.toThrow("Fitbit connection changed during sync");

    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("cleanupFitbitData", () => {
  it("deletes only the disconnected user's Fitbit-derived data", async () => {
    const t = convexTest(schema, modules);
    const [userId, otherUserId] = await t.run(async (ctx) => [
      await ctx.db.insert("users", {}),
      await ctx.db.insert("users", {}),
    ]);
    await t.run(async (ctx) => {
      for (const [owner, externalId, source, generation] of [
        [userId, "target-fitbit", "fitbit", "target-generation"],
        [userId, "target-garmin", "garmin", undefined],
        [otherUserId, "other-fitbit", "fitbit", "other-generation"],
      ] as const) {
        await ctx.db.insert("externalActivities", {
          userId: owner,
          externalId,
          workoutType: "running",
          beginTime: "2026-07-28T12:00:00Z",
          totalDuration: 1800,
          source,
          ...(generation ? { fitbitConnectionGeneration: generation } : {}),
          syncedAt: 1000,
        });
      }
      await ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "target-generation",
        calendarDate: "2026-07-28",
        restingHeartRate: 54,
        lastIngestedAt: 1000,
      });
      await ctx.db.insert("fitbitWellnessDaily", {
        userId: otherUserId,
        generation: "other-generation",
        calendarDate: "2026-07-28",
        restingHeartRate: 60,
        lastIngestedAt: 1000,
      });
    });

    await t.mutation(internal.fitbit.sync.cleanupFitbitData, {
      userId,
      generation: "target-generation",
    });

    const remaining = await t.run(async (ctx) => ({
      activities: await ctx.db.query("externalActivities").collect(),
      wellness: await ctx.db.query("fitbitWellnessDaily").collect(),
    }));
    expect(remaining.activities.map((row) => row.externalId).sort()).toEqual([
      "other-fitbit",
      "target-garmin",
    ]);
    expect(remaining.wellness.map((row) => row.userId)).toEqual([otherUserId]);
  });
});
