/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../strava/${key.slice(2)}` : key] = value;
}

async function createUser(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return t.run(async (ctx) => ctx.db.insert("users", {}));
}

async function connect(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  athleteId = "athlete-1",
  generation = "generation-1",
) {
  await t.mutation(internal.strava.connections.upsertActiveConnection, {
    userId,
    athleteId,
    generation,
    accessTokenEncrypted: "access",
    refreshTokenEncrypted: "refresh",
    tokenExpiresAt: 10_000,
    scopes: ["activity:read"],
    refreshDueAt: 9_000,
    now: 1_000,
  });
}

function activity(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    providerActivityId: "123",
    athleteId: "athlete-1",
    type: "Run",
    sportType: "TrailRun",
    name: "Morning run",
    startDate: "2026-07-29T12:00:00.000Z",
    startDateLocal: "2026-07-29T06:00:00.000Z",
    timezone: "(GMT-07:00) America/Denver",
    distanceMeters: 5_000,
    movingTimeSeconds: 1_500,
    elapsedTimeSeconds: 1_800,
    elevationGainMeters: 120,
    achievementCount: 2,
    trainer: false,
    commute: false,
    manual: false,
    private: false as const,
    ...overrides,
  };
}

describe("Strava activity persistence", () => {
  it("projects approved summary load fields and updates the same generation row", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);

    await expect(
      t.mutation(internal.strava.activityPersistence.upsertActivity, {
        userId,
        athleteId: "athlete-1",
        generation: "generation-1",
        activity: activity(),
        now: 2_000,
      }),
    ).resolves.toBe("upserted");
    await t.mutation(internal.strava.activityPersistence.upsertActivity, {
      userId,
      athleteId: "athlete-1",
      generation: "generation-1",
      activity: activity({ elapsedTimeSeconds: 1_900 }),
      now: 3_000,
    });

    const rows = await t.run(async (ctx) => ctx.db.query("externalActivities").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId,
      externalId: "strava:123",
      workoutType: "TrailRun",
      beginTime: "2026-07-29T12:00:00.000Z",
      totalDuration: 1_900,
      source: "strava",
      distance: 5_000,
      elevationGainMeters: 120,
      avgPaceSecondsPerKm: 300,
      stravaConnectionGeneration: "generation-1",
      syncedAt: 3_000,
    });
    expect(rows[0]).not.toHaveProperty("name");
    expect(rows[0]).not.toHaveProperty("achievementCount");
  });

  it("ignores wrong ownership, stale generations, and account deletion", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    const base = {
      userId,
      athleteId: "athlete-1",
      generation: "generation-1",
      activity: activity(),
      now: 2_000,
    };

    await expect(
      t.mutation(internal.strava.activityPersistence.upsertActivity, {
        ...base,
        athleteId: "other-athlete",
      }),
    ).resolves.toBe("ignored");
    await expect(
      t.mutation(internal.strava.activityPersistence.upsertActivity, {
        ...base,
        generation: "stale-generation",
      }),
    ).resolves.toBe("ignored");
    await t.run(async (ctx) => ctx.db.patch(userId, { deletionInProgress: true }));
    await expect(
      t.mutation(internal.strava.activityPersistence.upsertActivity, base),
    ).resolves.toBe("ignored");
    await expect(
      t.run(async (ctx) => ctx.db.query("externalActivities").collect()),
    ).resolves.toEqual([]);
  });

  it("does not let an older delivery overwrite a newer projection", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    const args = { userId, athleteId: "athlete-1", generation: "generation-1" };
    await t.mutation(internal.strava.activityPersistence.upsertActivity, {
      ...args,
      activity: activity({ elapsedTimeSeconds: 2_000 }),
      now: 3_000,
    });

    await expect(
      t.mutation(internal.strava.activityPersistence.upsertActivity, {
        ...args,
        activity: activity({ elapsedTimeSeconds: 1_000 }),
        now: 2_000,
      }),
    ).resolves.toBe("ignored");
    const row = await t.run(async (ctx) => ctx.db.query("externalActivities").unique());
    expect(row).toMatchObject({ totalDuration: 2_000, syncedAt: 3_000 });
  });

  it("persists a bounded page atomically after validating every owner", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    const base = { userId, athleteId: "athlete-1", generation: "generation-1", now: 2_000 };

    await expect(
      t.mutation(internal.strava.activityPersistence.upsertActivityBatch, {
        ...base,
        activities: [activity(), activity({ providerActivityId: "124", athleteId: "other" })],
      }),
    ).rejects.toThrow("Strava activity owner mismatch");
    await expect(
      t.run(async (ctx) => ctx.db.query("externalActivities").collect()),
    ).resolves.toEqual([]);

    await expect(
      t.mutation(internal.strava.activityPersistence.upsertActivityBatch, {
        ...base,
        activities: [activity(), activity({ providerActivityId: "124" })],
      }),
    ).resolves.toBe(2);
    await expect(
      t.run(async (ctx) => ctx.db.query("externalActivities").collect()),
    ).resolves.toHaveLength(2);
  });

  it("deletes only the exact active owner generation activity", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    const owner = { userId, athleteId: "athlete-1", generation: "generation-1" };
    await t.mutation(internal.strava.activityPersistence.upsertActivity, {
      ...owner,
      activity: activity(),
      now: 2_000,
    });

    await expect(
      t.mutation(internal.strava.activityPersistence.deleteActivity, {
        ...owner,
        generation: "stale-generation",
        providerActivityId: "123",
      }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internal.strava.activityPersistence.deleteActivity, {
        ...owner,
        providerActivityId: "123",
      }),
    ).resolves.toBe(true);
    await expect(
      t.run(async (ctx) => ctx.db.query("externalActivities").collect()),
    ).resolves.toEqual([]);
  });

  it("purges all disconnected-generation rows in bounded scheduled batches", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const userId = await createUser(t);
      await connect(t, userId);
      await t.run(async (ctx) => {
        for (let index = 0; index < 51; index += 1) {
          await ctx.db.insert("externalActivities", {
            userId,
            externalId: `strava:${index}`,
            workoutType: "Run",
            beginTime: `2026-07-29T12:${String(index).padStart(2, "0")}:00.000Z`,
            totalDuration: 60,
            source: "strava",
            stravaConnectionGeneration: "generation-1",
            syncedAt: 2_000,
          });
        }
        await ctx.db.insert("externalActivities", {
          userId,
          externalId: "other-source",
          workoutType: "Ride",
          beginTime: "2026-07-29T10:00:00.000Z",
          totalDuration: 60,
          source: "garmin",
          syncedAt: 2_000,
        });
      });

      await t.mutation(internal.strava.connections.claimDisconnect, {
        userId,
        reason: "user_disconnected",
        now: 3_000,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await t.run(async (ctx) => ctx.db.query("externalActivities").collect());
      expect(rows.map((row) => row.externalId)).toEqual(["other-source"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
