/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { FITBIT_READ_SCOPES } from "./config";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
const SYNC_NOW = Date.parse("2026-07-30T00:00:00.000Z");
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../fitbit/${key.slice(2)}` : key] = value;
}

async function createUser(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return t.run(async (ctx) => ctx.db.insert("users", {}));
}

async function connect(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  generation: string,
  scopes: readonly string[] = ["scope"],
) {
  await t.mutation(internal.fitbit.connections.upsertActiveConnection, {
    userId,
    healthUserId: `health-${generation}`,
    generation,
    accessTokenEncrypted: "access",
    refreshTokenEncrypted: "refresh",
    tokenExpiresAt: 10_000,
    scopes: [...scopes],
    refreshDueAt: 9_000,
    now: 1_000,
  });
}

function activity(externalId: string, beginTime = "2026-07-20T12:00:00.000Z") {
  return {
    externalId,
    workoutType: "Run",
    beginTime,
    totalDuration: 1800,
    source: "fitbit" as const,
  };
}

describe("direct Fitbit activity persistence", () => {
  it("reconciles the generation to the exact returned window and preserves Tonal Fitbit rows", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId, "generation-1");
    await t.run(async (ctx) => {
      await ctx.db.insert("externalActivities", {
        userId,
        ...activity("google-health:absent"),
        fitbitConnectionGeneration: "generation-1",
        syncedAt: 1000,
      });
      await ctx.db.insert("externalActivities", {
        userId,
        ...activity("google-health:old", "2026-06-01T12:00:00.000Z"),
        fitbitConnectionGeneration: "generation-1",
        syncedAt: 1000,
      });
      await ctx.db.insert("externalActivities", {
        userId,
        ...activity("tonal-fitbit-row"),
        syncedAt: 1000,
      });
    });

    await t.mutation(internal.fitbit.activityPersistence.reconcileExternalActivities, {
      userId,
      generation: "generation-1",
      startDate: "2026-07-01",
      now: SYNC_NOW,
      activities: [
        activity("google-health:return", "2026-07-21T12:00:00.000Z"),
        activity("google-health:civil-boundary", "2026-06-30T23:30:00.000Z"),
        activity("google-health:duplicate-of-tonal"),
      ],
    });

    const rows = await t.run(async (ctx) => ctx.db.query("externalActivities").collect());
    expect(rows.map((row) => row.externalId).sort()).toEqual([
      "google-health:civil-boundary",
      "google-health:return",
      "tonal-fitbit-row",
    ]);
    expect(rows.find((row) => row.externalId === "google-health:return")).toMatchObject({
      fitbitConnectionGeneration: "generation-1",
      syncedAt: SYNC_NOW,
    });
    expect(rows.find((row) => row.externalId === "tonal-fitbit-row")).not.toHaveProperty(
      "fitbitConnectionGeneration",
    );
  });

  it("does not recreate activities when disconnect wins before persistence", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId, "generation-1");
    await t.mutation(internal.fitbit.connections.markDisconnected, {
      userId,
      generation: "generation-1",
      reason: "user_disconnected",
      now: 2000,
    });

    await expect(
      t.mutation(internal.fitbit.activityPersistence.reconcileExternalActivities, {
        userId,
        generation: "generation-1",
        startDate: "2026-07-01",
        now: 3000,
        activities: [activity("google-health:late")],
      }),
    ).resolves.toBe(false);
    await expect(
      t.run(async (ctx) => ctx.db.query("externalActivities").collect()),
    ).resolves.toEqual([]);
  });

  it("does not overwrite or delete rows written by a newer overlapping reconciliation", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId, "generation-1");
    await t.run(async (ctx) => {
      await ctx.db.insert("externalActivities", {
        userId,
        ...activity("google-health:updated"),
        totalDuration: 2400,
        fitbitConnectionGeneration: "generation-1",
        syncedAt: 3000,
      });
      await ctx.db.insert("externalActivities", {
        userId,
        ...activity("google-health:new"),
        fitbitConnectionGeneration: "generation-1",
        syncedAt: 3000,
      });
    });

    await t.mutation(internal.fitbit.activityPersistence.reconcileExternalActivities, {
      userId,
      generation: "generation-1",
      startDate: "2026-07-01",
      now: 2000,
      activities: [activity("google-health:updated")],
    });

    const rows = await t.run(async (ctx) => ctx.db.query("externalActivities").collect());
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.externalId === "google-health:updated")).toMatchObject({
      totalDuration: 2400,
      syncedAt: 3000,
    });
    expect(rows.find((row) => row.externalId === "google-health:new")).toMatchObject({
      syncedAt: 3000,
    });
  });

  it("bounds deduplication candidates to the current civil-date sync window", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId, "generation-1");
    await t.run(async (ctx) => {
      for (let index = 0; index < 1001; index += 1) {
        await ctx.db.insert("externalActivities", {
          userId,
          ...activity(`tonal-fitbit-old-${index}`, "2026-05-01T12:00:00.000Z"),
          syncedAt: 1000,
        });
      }
      await ctx.db.insert("externalActivities", {
        userId,
        ...activity("tonal-fitbit-recent", "2026-06-30T23:30:00.000Z"),
        syncedAt: 1000,
      });
    });

    await expect(
      t.mutation(internal.fitbit.activityPersistence.reconcileExternalActivities, {
        userId,
        generation: "generation-1",
        startDate: "2026-07-01",
        now: SYNC_NOW,
        activities: [activity("google-health:duplicate", "2026-06-30T23:30:00.000Z")],
      }),
    ).resolves.toBe(true);

    const directRows = await t.run(async (ctx) =>
      ctx.db
        .query("externalActivities")
        .withIndex("by_userId_and_fitbitConnectionGeneration_and_externalId", (q) =>
          q.eq("userId", userId).eq("fitbitConnectionGeneration", "generation-1"),
        )
        .collect(),
    );
    expect(directRows).toEqual([]);
  });

  it("old-generation cleanup after reconnect leaves new activity and wellness data intact", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId, "generation-old");
    await t.run(async (ctx) => {
      await ctx.db.insert("externalActivities", {
        userId,
        ...activity("google-health:old"),
        fitbitConnectionGeneration: "generation-old",
        syncedAt: 1000,
      });
      await ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-old",
        calendarDate: "2026-07-20",
        restingHeartRate: 60,
        lastIngestedAt: 1000,
      });
    });
    await connect(t, userId, "generation-new");
    await t.mutation(internal.fitbit.activityPersistence.reconcileExternalActivities, {
      userId,
      generation: "generation-new",
      startDate: "2026-07-01",
      now: 2000,
      activities: [activity("google-health:new")],
    });
    await t.mutation(internal.fitbit.wellnessDaily.upsertWellnessDaily, {
      userId,
      generation: "generation-new",
      startDate: "2026-07-01",
      syncedDataTypes: ["daily-resting-heart-rate"],
      now: 2000,
      entries: [{ calendarDate: "2026-07-20", fields: { restingHeartRate: 50 } }],
    });

    await t.mutation(internal.fitbit.sync.cleanupFitbitData, {
      userId,
      generation: "generation-old",
    });

    const remaining = await t.run(async (ctx) => ({
      activities: await ctx.db.query("externalActivities").collect(),
      wellness: await ctx.db.query("fitbitWellnessDaily").collect(),
    }));
    expect(remaining.activities.map((row) => row.externalId)).toEqual(["google-health:new"]);
    expect(remaining.wellness).toHaveLength(1);
    expect(remaining.wellness[0]).toMatchObject({
      generation: "generation-new",
      restingHeartRate: 50,
    });
  });

  it("purges only direct activities for the revoked generation and stops after regrant", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId, "generation-1", [FITBIT_READ_SCOPES[2]]);
    await t.run(async (ctx) => {
      await ctx.db.insert("externalActivities", {
        userId,
        ...activity("google-health:revoked"),
        fitbitConnectionGeneration: "generation-1",
        syncedAt: 1000,
      });
      await ctx.db.insert("externalActivities", {
        userId,
        ...activity("google-health:other-generation"),
        fitbitConnectionGeneration: "generation-old",
        syncedAt: 1000,
      });
      await ctx.db.insert("externalActivities", {
        userId,
        ...activity("tonal-fitbit-row"),
        syncedAt: 1000,
      });
    });

    await expect(
      t.mutation(internal.fitbit.activityPersistence.purgeRevokedActivityScope, {
        userId,
        generation: "generation-1",
      }),
    ).resolves.toBe(true);
    let rows = await t.run(async (ctx) => ctx.db.query("externalActivities").collect());
    expect(rows.map((row) => row.externalId).sort()).toEqual([
      "google-health:other-generation",
      "tonal-fitbit-row",
    ]);

    await t.run(async (ctx) => {
      const connection = await ctx.db
        .query("fitbitConnections")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();
      if (!connection) throw new Error("Expected Fitbit connection");
      await ctx.db.patch(connection._id, {
        scopes: [FITBIT_READ_SCOPES[0], FITBIT_READ_SCOPES[2]],
      });
      await ctx.db.insert("externalActivities", {
        userId,
        ...activity("google-health:regranted"),
        fitbitConnectionGeneration: "generation-1",
        syncedAt: 2000,
      });
    });
    await expect(
      t.mutation(internal.fitbit.activityPersistence.purgeRevokedActivityScope, {
        userId,
        generation: "generation-1",
      }),
    ).resolves.toBe(false);
    rows = await t.run(async (ctx) => ctx.db.query("externalActivities").collect());
    expect(rows.map((row) => row.externalId)).toContain("google-health:regranted");
  });

  it("continues revoked activity cleanup beyond one bounded batch", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const userId = await createUser(t);
      await connect(t, userId, "generation-1", [FITBIT_READ_SCOPES[2]]);
      await t.run(async (ctx) => {
        for (let index = 0; index < 51; index += 1) {
          await ctx.db.insert("externalActivities", {
            userId,
            ...activity(`google-health:revoked-${index}`),
            fitbitConnectionGeneration: "generation-1",
            syncedAt: 1000,
          });
        }
        await ctx.db.insert("externalActivities", {
          userId,
          ...activity("tonal-fitbit-row"),
          syncedAt: 1000,
        });
      });

      await t.mutation(internal.fitbit.activityPersistence.purgeRevokedActivityScope, {
        userId,
        generation: "generation-1",
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await t.run(async (ctx) => ctx.db.query("externalActivities").collect());
      expect(rows.map((row) => row.externalId)).toEqual(["tonal-fitbit-row"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
