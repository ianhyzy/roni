/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { readRecoveryInputs } from "./read";

const modules = import.meta.glob("../**/*.*s");

async function createUser(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await t.run(async (ctx) => ctx.db.insert("users", {}));
}

describe("readRecoveryInputs", () => {
  test("normalizes connected Garmin, current-generation Fitbit, preference, and check-in data", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    const now = 1_775_000_000_000;
    await t.run(async (ctx) => {
      await ctx.db.insert("userProfiles", {
        userId,
        tonalUserId: "tonal-user",
        tonalToken: "encrypted",
        lastActiveAt: now,
        preferredRecoverySource: "garmin",
      });
      await ctx.db.insert("garminConnections", {
        userId,
        garminUserId: "garmin-user",
        accessTokenEncrypted: "encrypted",
        accessTokenSecretEncrypted: "encrypted",
        permissions: [],
        connectedAt: now,
        status: "active",
      });
      await ctx.db.insert("fitbitConnections", {
        userId,
        healthUserId: "fitbit-user",
        generation: "generation-current",
        status: "active",
        accessTokenEncrypted: "encrypted",
        refreshTokenEncrypted: "encrypted",
        tokenExpiresAt: now + 60_000,
        scopes: [],
        connectedAt: now,
        refreshDueAt: now + 60_000,
      });
      await ctx.db.insert("garminWellnessDaily", {
        userId,
        calendarDate: "2026-07-30",
        sleepDurationSeconds: 20_000,
        hrvLastNightAvg: 41,
        hrvStatus: "LOW",
        bodyBatteryHighestValue: 28,
        lastIngestedAt: now,
      });
      await ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-current",
        calendarDate: "2026-07-30",
        sleepDurationSeconds: 26_000,
        restingHeartRate: 53,
        averageHrvMilliseconds: 49,
        lastIngestedAt: now,
      });
      await ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-old",
        calendarDate: "2026-07-30",
        sleepDurationSeconds: 99_999,
        lastIngestedAt: now,
      });
      await ctx.db.insert("recoveryCheckIns", {
        userId,
        calendarDate: "2026-07-30",
        energy: 2,
        soreness: 4,
        stress: 3,
        notes: "Heavy legs",
        createdAt: now,
        updatedAt: now,
      });
    });

    const result = await t.run(async (ctx) => readRecoveryInputs(ctx, userId));

    expect(result.activeFitbitGeneration).toBe("generation-current");
    expect(result.inputs.preferredSource).toBe("garmin");
    expect(result.inputs.observations).toEqual([
      expect.objectContaining({
        source: "garmin",
        hrvMilliseconds: 41,
        hrvStatus: "LOW",
        bodyBatteryHighestValue: 28,
      }),
      expect.objectContaining({
        source: "fitbit",
        sleepDurationSeconds: 26_000,
        hrvMilliseconds: 49,
      }),
    ]);
    expect(result.inputs.observations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sleepDurationSeconds: 99_999 })]),
    );
    expect(result.inputs.checkIns).toEqual([
      {
        calendarDate: "2026-07-30",
        energy: 2,
        soreness: 4,
        stress: 3,
        notes: "Heavy legs",
        updatedAt: now,
      },
    ]);
  });

  test("excludes recovery rows when their provider connection is disconnected", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    const now = 1_775_000_000_000;
    await t.run(async (ctx) => {
      await ctx.db.insert("garminConnections", {
        userId,
        garminUserId: "garmin-user",
        accessTokenEncrypted: "encrypted",
        accessTokenSecretEncrypted: "encrypted",
        permissions: [],
        connectedAt: now - 60_000,
        disconnectedAt: now,
        disconnectReason: "user_disconnected",
        status: "disconnected",
      });
      await ctx.db.insert("fitbitConnections", {
        userId,
        healthUserId: "fitbit-user",
        generation: "generation-old",
        status: "disconnected",
        scopes: [],
        connectedAt: now - 60_000,
        disconnectedAt: now,
        disconnectReason: "user_disconnected",
      });
      await ctx.db.insert("garminWellnessDaily", {
        userId,
        calendarDate: "2026-07-30",
        sleepDurationSeconds: 25_200,
        lastIngestedAt: now,
      });
      await ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-old",
        calendarDate: "2026-07-30",
        sleepDurationSeconds: 25_200,
        lastIngestedAt: now,
      });
    });

    const result = await t.run(async (ctx) => readRecoveryInputs(ctx, userId));

    expect(result.activeFitbitGeneration).toBeNull();
    expect(result.inputs.observations).toEqual([]);
  });

  test("preserves Fitbit recovery when the Garmin wellness read fails", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    const now = 1_775_000_000_000;
    await t.run(async (ctx) => {
      await ctx.db.insert("garminConnections", {
        userId,
        garminUserId: "garmin-user",
        accessTokenEncrypted: "encrypted",
        accessTokenSecretEncrypted: "encrypted",
        permissions: [],
        connectedAt: now,
        status: "active",
      });
      await ctx.db.insert("fitbitConnections", {
        userId,
        healthUserId: "fitbit-user",
        generation: "generation-current",
        status: "active",
        accessTokenEncrypted: "encrypted",
        refreshTokenEncrypted: "encrypted",
        tokenExpiresAt: now + 60_000,
        scopes: [],
        connectedAt: now,
        refreshDueAt: now + 60_000,
      });
      await ctx.db.insert("fitbitWellnessDaily", {
        userId,
        generation: "generation-current",
        calendarDate: "2026-07-30",
        sleepDurationSeconds: 25_200,
        lastIngestedAt: now,
      });
    });
    const readError = new Error("Garmin read failed");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await t.run(async (ctx) => {
        const db = new Proxy(ctx.db, {
          get(target, property, receiver) {
            if (property === "query") {
              return (table: Parameters<typeof target.query>[0]) => {
                if (table === "garminWellnessDaily") throw readError;
                return target.query(table);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        });
        return await readRecoveryInputs({ db }, userId);
      });

      expect(result.inputs.observations).toEqual([
        expect.objectContaining({ source: "fitbit", sleepDurationSeconds: 25_200 }),
      ]);
      expect(errorSpy).toHaveBeenCalledWith(
        "readRecoveryInputs: garminWellness read failed",
        readError,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("bounds provider history and subjective check-ins", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    const now = 1_775_000_000_000;
    await t.run(async (ctx) => {
      await ctx.db.insert("garminConnections", {
        userId,
        garminUserId: "garmin-user",
        accessTokenEncrypted: "encrypted",
        accessTokenSecretEncrypted: "encrypted",
        permissions: [],
        connectedAt: now,
        status: "active",
      });
      for (let index = 0; index < 9; index += 1) {
        const calendarDate = `2026-07-${String(30 - index).padStart(2, "0")}`;
        await ctx.db.insert("garminWellnessDaily", {
          userId,
          calendarDate,
          sleepDurationSeconds: 25_200,
          lastIngestedAt: now - index,
        });
        await ctx.db.insert("recoveryCheckIns", {
          userId,
          calendarDate,
          energy: 3,
          soreness: 3,
          stress: 3,
          createdAt: now - index,
          updatedAt: now - index,
        });
      }
    });

    const result = await t.run(async (ctx) => readRecoveryInputs(ctx, userId));

    expect(result.inputs.observations).toHaveLength(7);
    expect(result.inputs.checkIns).toHaveLength(7);
  });
});
