/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { FITBIT_READ_SCOPES } from "./config";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../fitbit/${key.slice(2)}` : key] = value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Fitbit connection sync coordination", () => {
  it("purges data for scopes removed by a token refresh", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(internal.fitbit.connections.upsertActiveConnection, {
      userId,
      healthUserId: "health-user-1",
      generation: "generation-1",
      accessTokenEncrypted: "access-1",
      refreshTokenEncrypted: "refresh-1",
      tokenExpiresAt: 2_000,
      scopes: [...FITBIT_READ_SCOPES],
      refreshDueAt: 1_500,
      now: 1_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("externalActivities", {
        userId,
        externalId: "google-health:workout-1",
        workoutType: "run",
        beginTime: "2026-07-20T12:00:00.000Z",
        totalDuration: 1800,
        source: "fitbit",
        fitbitConnectionGeneration: "generation-1",
        syncedAt: 1_000,
      });
      await ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-1",
        calendarDate: "2026-07-20",
        sleepDurationSeconds: 25_200,
        restingHeartRate: 54,
        averageHrvMilliseconds: 46.5,
        lastIngestedAt: 1_000,
      });
    });

    await expect(
      t.mutation(internal.fitbit.connections.replaceTokens, {
        userId,
        generation: "generation-1",
        accessTokenEncrypted: "access-2",
        refreshTokenEncrypted: "refresh-2",
        tokenExpiresAt: 3_000,
        expectedTokenExpiresAt: 2_000,
        scopes: [FITBIT_READ_SCOPES[2]],
        refreshDueAt: 2_500,
      }),
    ).resolves.toBe(true);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await t.run(async (ctx) => ({
      activities: await ctx.db.query("externalActivities").collect(),
      wellness: await ctx.db.query("fitbitWellnessDaily").collect(),
    }));
    expect(rows.activities).toEqual([]);
    expect(rows.wellness).toHaveLength(1);
    expect(rows.wellness[0]).toMatchObject({ sleepDurationSeconds: 25_200 });
    expect(rows.wellness[0]).not.toHaveProperty("restingHeartRate");
    expect(rows.wellness[0]).not.toHaveProperty("averageHrvMilliseconds");
  });

  it("ignores a sync result older than the latest recorded attempt", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(internal.fitbit.connections.upsertActiveConnection, {
      userId,
      healthUserId: "health-user-1",
      generation: "generation-1",
      accessTokenEncrypted: "access-1",
      refreshTokenEncrypted: "refresh-1",
      tokenExpiresAt: 20_000,
      scopes: [...FITBIT_READ_SCOPES],
      refreshDueAt: 10_000,
      now: 1_000,
    });

    await expect(
      t.mutation(internal.fitbit.connections.recordSyncResult, {
        userId,
        generation: "generation-1",
        now: 3_000,
        nextRefreshDueAt: 30_000,
      }),
    ).resolves.toBe(true);
    await expect(
      t.mutation(internal.fitbit.connections.recordSyncResult, {
        userId,
        generation: "generation-1",
        now: 2_000,
        nextRefreshDueAt: 20_000,
        error: "stale failure",
      }),
    ).resolves.toBe(true);

    const row = await t.run(async (ctx) => ctx.db.query("fitbitConnections").unique());
    expect(row).toMatchObject({
      refreshDueAt: 30_000,
      lastSyncAttemptAt: 3_000,
      lastSyncedAt: 3_000,
    });
    expect(row).not.toHaveProperty("lastSyncError");
  });
});
