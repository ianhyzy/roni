/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../fitbit/${key.slice(2)}` : key] = value;
}

describe("Fitbit wellness generation reconciliation", () => {
  it("replaces duplicate prior-generation rows for one calendar date", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(internal.fitbit.connections.upsertActiveConnection, {
      userId,
      healthUserId: "health-user-1",
      generation: "generation-new",
      accessTokenEncrypted: "access",
      refreshTokenEncrypted: "refresh",
      tokenExpiresAt: 10_000,
      scopes: ["scope"],
      refreshDueAt: 9_000,
      now: 1_000,
    });
    await t.run(async (ctx) => {
      for (const generation of ["generation-old-1", "generation-old-2"]) {
        await ctx.db.insert("fitbitWellnessDaily", {
          userId,
          generation,
          calendarDate: "2026-07-20",
          restingHeartRate: 60,
          lastIngestedAt: 500,
        });
      }
    });

    await expect(
      t.mutation(internal.fitbit.wellnessDaily.upsertWellnessDaily, {
        userId,
        generation: "generation-new",
        startDate: "2026-07-01",
        syncedDataTypes: ["daily-resting-heart-rate"],
        now: 2_000,
        entries: [{ calendarDate: "2026-07-20", fields: { restingHeartRate: 54 } }],
      }),
    ).resolves.toBe(true);

    const rows = await t.run(async (ctx) => ctx.db.query("fitbitWellnessDaily").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      generation: "generation-new",
      calendarDate: "2026-07-20",
      restingHeartRate: 54,
      lastIngestedAt: 2_000,
    });
  });
});
