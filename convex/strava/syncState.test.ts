/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { recordSyncResult } from "./syncState";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../strava/${key.slice(2)}` : key] = value;
}

async function connect(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  await t.mutation(internal.strava.connections.upsertActiveConnection, {
    userId,
    athleteId: "athlete-1",
    generation: "generation-1",
    accessTokenEncrypted: "access",
    refreshTokenEncrypted: "refresh",
    tokenExpiresAt: 10_000,
    scopes: ["activity:read"],
    refreshDueAt: 9_000,
    now: 1_000,
  });
  return userId;
}

describe("Strava sync state", () => {
  it("exports a top-level object args validator", () => {
    const exportArgs: unknown = Reflect.get(recordSyncResult, "exportArgs");
    expect(exportArgs).toBeTypeOf("function");
    if (typeof exportArgs !== "function") throw new Error("Missing Convex args exporter");

    expect(JSON.parse(Reflect.apply(exportArgs, recordSyncResult, []))).toMatchObject({
      type: "object",
      value: {
        result: { optional: false },
      },
    });
  });

  it("records success, clears prior errors, and rejects an older attempt", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    await t.mutation(internal.strava.syncState.recordSyncResult, {
      userId,
      generation: "generation-1",
      attemptedAt: 2_000,
      result: { status: "failure", error: "transient failure" },
    });
    await expect(
      t.mutation(internal.strava.syncState.recordSyncResult, {
        userId,
        generation: "generation-1",
        attemptedAt: 3_000,
        result: { status: "success", succeededAt: 3_100 },
      }),
    ).resolves.toBe(true);
    await expect(
      t.mutation(internal.strava.syncState.recordSyncResult, {
        userId,
        generation: "generation-1",
        attemptedAt: 2_500,
        result: { status: "failure", error: "older failure" },
      }),
    ).resolves.toBe(false);

    const row = await t.run(async (ctx) => ctx.db.query("stravaConnections").unique());
    expect(row).toMatchObject({ lastSyncAttemptAt: 3_000, lastSyncedAt: 3_100 });
    expect(row).not.toHaveProperty("lastSyncError");
  });

  it("records failure without changing the last successful timestamp", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    await t.mutation(internal.strava.syncState.recordSyncResult, {
      userId,
      generation: "generation-1",
      attemptedAt: 2_000,
      result: { status: "success", succeededAt: 2_100 },
    });

    await expect(
      t.mutation(internal.strava.syncState.recordSyncResult, {
        userId,
        generation: "generation-1",
        attemptedAt: 3_000,
        result: { status: "failure", error: "provider unavailable" },
      }),
    ).resolves.toBe(true);

    const row = await t.run(async (ctx) => ctx.db.query("stravaConnections").unique());
    expect(row).toMatchObject({
      lastSyncAttemptAt: 3_000,
      lastSyncedAt: 2_100,
      lastSyncError: "provider unavailable",
    });
  });

  it.each([
    ["neither result payload", { status: "success" }],
    ["both result payloads", { status: "success", succeededAt: 2_100, error: "failure" }],
  ])("rejects %s", async (_label, result) => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);

    await expect(
      t.mutation(internal.strava.syncState.recordSyncResult, {
        userId,
        generation: "generation-1",
        attemptedAt: 2_000,
        result,
      } as never),
    ).rejects.toThrow();
  });

  it("disconnects only the exact generation and purges its activities", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const userId = await connect(t);
      await t.run(async (ctx) => {
        await ctx.db.insert("externalActivities", {
          userId,
          externalId: "strava:123",
          workoutType: "Run",
          beginTime: "2026-07-29T12:00:00.000Z",
          totalDuration: 1_800,
          source: "strava",
          stravaConnectionGeneration: "generation-1",
          syncedAt: 2_000,
        });
      });
      await expect(
        t.mutation(internal.strava.syncState.markProviderDisconnected, {
          userId,
          generation: "stale",
          reason: "token_invalid",
          now: 2_500,
        }),
      ).resolves.toBe(false);
      await expect(
        t.mutation(internal.strava.syncState.markProviderDisconnected, {
          userId,
          generation: "generation-1",
          reason: "permission_revoked",
          now: 3_000,
        }),
      ).resolves.toBe(true);
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await t.run(async (ctx) => ({
        connection: await ctx.db.query("stravaConnections").unique(),
        activities: await ctx.db.query("externalActivities").collect(),
      }));
      expect(rows.connection).toMatchObject({
        status: "disconnected",
        disconnectReason: "permission_revoked",
      });
      expect(rows.connection).not.toHaveProperty("accessTokenEncrypted");
      expect(rows.activities).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
