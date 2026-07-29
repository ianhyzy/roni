/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { FITBIT_READ_SCOPES } from "./config";
import { compactFitbitWellnessFields } from "./wellnessDaily";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../fitbit/${key.slice(2)}` : key] = value;
}

async function createActiveConnection(
  t: ReturnType<typeof convexTest>,
  generation = "generation-1",
  scopes: readonly string[] = ["scope"],
): Promise<Id<"users">> {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
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
  return userId;
}

describe("Fitbit wellness persistence", () => {
  it("compacts undefined partial fields without dropping numeric zero", () => {
    expect(
      compactFitbitWellnessFields({
        awakeSeconds: 0,
        restingHeartRate: undefined,
        averageHrvMilliseconds: 42,
      }),
    ).toEqual({ awakeSeconds: 0, averageHrvMilliseconds: 42 });
  });

  it("merges independent same-day fields within one connection generation", async () => {
    const t = convexTest(schema, modules);
    const userId = await createActiveConnection(t);
    await t.mutation(internal.fitbit.wellnessDaily.upsertWellnessDaily, {
      userId,
      generation: "generation-1",
      startDate: "2026-07-01",
      syncedDataTypes: ["sleep"],
      now: 1000,
      entries: [
        {
          calendarDate: "2026-07-21",
          fields: { sleepDurationSeconds: 25_200, deepSleepSeconds: 4200 },
        },
      ],
    });
    await t.mutation(internal.fitbit.wellnessDaily.upsertWellnessDaily, {
      userId,
      generation: "generation-1",
      startDate: "2026-07-01",
      syncedDataTypes: ["daily-resting-heart-rate", "daily-heart-rate-variability"],
      now: 2000,
      entries: [
        {
          calendarDate: "2026-07-21",
          fields: { restingHeartRate: 54, averageHrvMilliseconds: 46.5 },
        },
      ],
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("fitbitWellnessDaily")
        .withIndex("by_userId_and_calendarDate", (q) =>
          q.eq("userId", userId).eq("calendarDate", "2026-07-21"),
        )
        .unique(),
    );
    expect(row).toMatchObject({
      generation: "generation-1",
      sleepDurationSeconds: 25_200,
      deepSleepSeconds: 4200,
      restingHeartRate: 54,
      averageHrvMilliseconds: 46.5,
      lastIngestedAt: 2000,
    });
  });

  it("clears refreshed fields that disappear while preserving unsynced metrics", async () => {
    const t = convexTest(schema, modules);
    const userId = await createActiveConnection(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-1",
        calendarDate: "2026-07-21",
        sleepDurationSeconds: 25_200,
        deepSleepSeconds: 4200,
        restingHeartRate: 54,
        averageHrvMilliseconds: 46.5,
        lastIngestedAt: 1000,
      });
      await ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-1",
        calendarDate: "2026-07-20",
        sleepDurationSeconds: 24_000,
        lastIngestedAt: 1000,
      });
    });

    await t.mutation(internal.fitbit.wellnessDaily.upsertWellnessDaily, {
      userId,
      generation: "generation-1",
      startDate: "2026-07-01",
      syncedDataTypes: ["sleep", "daily-resting-heart-rate"],
      now: 2000,
      entries: [
        {
          calendarDate: "2026-07-21",
          fields: { sleepDurationSeconds: 26_000 },
        },
      ],
    });

    const rows = await t.run(async (ctx) => ctx.db.query("fitbitWellnessDaily").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      calendarDate: "2026-07-21",
      sleepDurationSeconds: 26_000,
      averageHrvMilliseconds: 46.5,
      lastIngestedAt: 2000,
    });
    expect(rows[0]).not.toHaveProperty("deepSleepSeconds");
    expect(rows[0]).not.toHaveProperty("restingHeartRate");
  });

  it("preserves a row written by a newer overlapping sync", async () => {
    const t = convexTest(schema, modules);
    const userId = await createActiveConnection(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-1",
        calendarDate: "2026-07-21",
        sleepDurationSeconds: 26_000,
        restingHeartRate: 52,
        lastIngestedAt: 3000,
      });
    });

    await t.mutation(internal.fitbit.wellnessDaily.upsertWellnessDaily, {
      userId,
      generation: "generation-1",
      startDate: "2026-07-01",
      syncedDataTypes: ["sleep", "daily-resting-heart-rate"],
      now: 2000,
      entries: [],
    });

    const row = await t.run(async (ctx) => ctx.db.query("fitbitWellnessDaily").unique());
    expect(row).toMatchObject({
      sleepDurationSeconds: 26_000,
      restingHeartRate: 52,
      lastIngestedAt: 3000,
    });
  });

  it("replaces same-date fields instead of merging data from an older generation", async () => {
    const t = convexTest(schema, modules);
    const userId = await createActiveConnection(t, "generation-new");
    await t.run(async (ctx) =>
      ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-old",
        calendarDate: "2026-07-21",
        sleepDurationSeconds: 25_200,
        lastIngestedAt: 1000,
      }),
    );

    await t.mutation(internal.fitbit.wellnessDaily.upsertWellnessDaily, {
      userId,
      generation: "generation-new",
      startDate: "2026-07-01",
      syncedDataTypes: ["daily-resting-heart-rate"],
      now: 2000,
      entries: [{ calendarDate: "2026-07-21", fields: { restingHeartRate: 54 } }],
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("fitbitWellnessDaily")
        .withIndex("by_userId_and_calendarDate", (q) =>
          q.eq("userId", userId).eq("calendarDate", "2026-07-21"),
        )
        .unique(),
    );
    expect(row).toMatchObject({ generation: "generation-new", restingHeartRate: 54 });
    expect(row).not.toHaveProperty("sleepDurationSeconds");
  });

  it("enforces the calendar cutoff instead of retaining the newest populated rows", async () => {
    const t = convexTest(schema, modules);
    const userId = await createActiveConnection(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-1",
        calendarDate: "2026-06-30",
        restingHeartRate: 50,
        lastIngestedAt: 1000,
      });
    });

    await t.mutation(internal.fitbit.wellnessDaily.upsertWellnessDaily, {
      userId,
      generation: "generation-1",
      startDate: "2026-07-01",
      syncedDataTypes: ["daily-resting-heart-rate"],
      now: 2000,
      entries: [
        { calendarDate: "2026-06-29", fields: { restingHeartRate: 49 } },
        { calendarDate: "2026-07-20", fields: { restingHeartRate: 55 } },
      ],
    });

    const rows = await t.run(async (ctx) => ctx.db.query("fitbitWellnessDaily").collect());
    expect(rows.map((row) => row.calendarDate)).toEqual(["2026-07-20"]);
  });

  it("does not recreate wellness after the same generation disconnects", async () => {
    const t = convexTest(schema, modules);
    const userId = await createActiveConnection(t);
    await t.mutation(internal.fitbit.connections.markDisconnected, {
      userId,
      generation: "generation-1",
      reason: "user_disconnected",
      now: 2000,
    });

    await expect(
      t.mutation(internal.fitbit.wellnessDaily.upsertWellnessDaily, {
        userId,
        generation: "generation-1",
        startDate: "2026-07-01",
        syncedDataTypes: ["daily-resting-heart-rate"],
        now: 3000,
        entries: [{ calendarDate: "2026-07-20", fields: { restingHeartRate: 55 } }],
      }),
    ).resolves.toBe(false);
    await expect(
      t.run(async (ctx) => ctx.db.query("fitbitWellnessDaily").collect()),
    ).resolves.toEqual([]);
  });

  it("clears only sleep-owned fields when sleep consent is revoked", async () => {
    const t = convexTest(schema, modules);
    const userId = await createActiveConnection(t, "generation-1", [FITBIT_READ_SCOPES[1]]);
    await t.run(async (ctx) =>
      ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-1",
        calendarDate: "2026-07-21",
        sleepDurationSeconds: 25_200,
        deepSleepSeconds: 4200,
        restingHeartRate: 54,
        averageHrvMilliseconds: 46.5,
        lastIngestedAt: 1000,
      }),
    );

    await expect(
      t.mutation(internal.fitbit.wellnessDaily.purgeRevokedWellnessScope, {
        userId,
        generation: "generation-1",
        scope: FITBIT_READ_SCOPES[2],
      }),
    ).resolves.toBe(true);

    const row = await t.run(async (ctx) => ctx.db.query("fitbitWellnessDaily").unique());
    expect(row).toMatchObject({ restingHeartRate: 54, averageHrvMilliseconds: 46.5 });
    expect(row).not.toHaveProperty("sleepDurationSeconds");
    expect(row).not.toHaveProperty("deepSleepSeconds");
  });

  it("clears both health metrics while preserving sleep when health consent is revoked", async () => {
    const t = convexTest(schema, modules);
    const userId = await createActiveConnection(t, "generation-1", [FITBIT_READ_SCOPES[2]]);
    await t.run(async (ctx) =>
      ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-1",
        calendarDate: "2026-07-21",
        sleepDurationSeconds: 25_200,
        restingHeartRate: 54,
        averageHrvMilliseconds: 46.5,
        lastIngestedAt: 1000,
      }),
    );

    await expect(
      t.mutation(internal.fitbit.wellnessDaily.purgeRevokedWellnessScope, {
        userId,
        generation: "generation-1",
        scope: FITBIT_READ_SCOPES[1],
      }),
    ).resolves.toBe(true);

    const row = await t.run(async (ctx) => ctx.db.query("fitbitWellnessDaily").unique());
    expect(row).toMatchObject({ sleepDurationSeconds: 25_200 });
    expect(row).not.toHaveProperty("restingHeartRate");
    expect(row).not.toHaveProperty("averageHrvMilliseconds");
  });

  it("advances through multiple cleanup pages when rows retain other scoped fields", async () => {
    vi.useFakeTimers();
    try {
      const t = convexTest(schema, modules);
      const userId = await createActiveConnection(t, "generation-1", [FITBIT_READ_SCOPES[1]]);
      await t.run(async (ctx) => {
        for (let index = 0; index < 51; index += 1) {
          await ctx.db.insert("fitbitWellnessDaily", {
            userId,
            generation: "generation-1",
            calendarDate: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
            sleepDurationSeconds: 25_200,
            restingHeartRate: 54,
            lastIngestedAt: 1000,
          });
        }
      });

      await t.mutation(internal.fitbit.wellnessDaily.purgeRevokedWellnessScope, {
        userId,
        generation: "generation-1",
        scope: FITBIT_READ_SCOPES[2],
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const rows = await t.run(async (ctx) => ctx.db.query("fitbitWellnessDaily").collect());
      expect(rows).toHaveLength(51);
      expect(rows.every((row) => row.restingHeartRate === 54)).toBe(true);
      expect(rows.every((row) => row.sleepDurationSeconds === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
