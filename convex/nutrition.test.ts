/// <reference types="vite/client" />
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

function createTest() {
  const testClient = convexTest(schema, modules);
  registerRateLimiter(testClient);
  return testClient;
}
async function createUser(testClient: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await testClient.run(async (ctx) => ctx.db.insert("users", {}));
}

afterEach(() => {
  vi.useRealTimers();
});
describe("nutrition daily logs", () => {
  test("upserts a portable manual log while preserving creation time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T18:00:00.000Z"));
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });

    const created = await authed.mutation(api.nutrition.upsertDailyMine, {
      calendarDate: "2026-07-30",
      caloriesKcal: 0,
      proteinGrams: 162.5,
      notes: "  Estimated from labels  ",
    });
    vi.setSystemTime(new Date("2026-07-30T19:00:00.000Z"));
    const updated = await authed.mutation(api.nutrition.upsertDailyMine, {
      calendarDate: "2026-07-30",
      carbsGrams: 210.25,
      notes: "   ",
    });

    expect(created).toEqual({
      calendarDate: "2026-07-30",
      source: "manual",
      caloriesKcal: 0,
      proteinGrams: 162.5,
      carbsGrams: null,
      fatGrams: null,
      notes: "Estimated from labels",
      createdAt: new Date("2026-07-30T18:00:00.000Z").getTime(),
      updatedAt: new Date("2026-07-30T18:00:00.000Z").getTime(),
    });
    expect(updated).toEqual({
      calendarDate: "2026-07-30",
      source: "manual",
      caloriesKcal: null,
      proteinGrams: null,
      carbsGrams: 210.25,
      fatGrams: null,
      notes: null,
      createdAt: created.createdAt,
      updatedAt: new Date("2026-07-30T19:00:00.000Z").getTime(),
    });
    expect(updated).not.toHaveProperty("_id");
    expect(updated).not.toHaveProperty("userId");
  });
  test("requires auth and keeps reads isolated by owner", async () => {
    const testClient = createTest();
    const firstUserId = await createUser(testClient);
    const secondUserId = await createUser(testClient);
    const first = testClient.withIdentity({ subject: `${firstUserId}|session` });
    const second = testClient.withIdentity({ subject: `${secondUserId}|session` });

    await first.mutation(api.nutrition.upsertDailyMine, {
      calendarDate: "2026-07-30",
      proteinGrams: 140,
      notes: "Private estimate",
    });

    await expect(testClient.query(api.nutrition.listRecentMine, {})).resolves.toEqual([]);
    await expect(second.query(api.nutrition.listRecentMine, {})).resolves.toEqual([]);
    await expect(
      testClient.mutation(api.nutrition.upsertDailyMine, {
        calendarDate: "2026-07-30",
        proteinGrams: 140,
      }),
    ).rejects.toThrow("Not authenticated");
    await expect(
      testClient.mutation(api.nutrition.deleteDailyMine, { calendarDate: "2026-07-30" }),
    ).rejects.toThrow("Not authenticated");
  });
  test.each([
    ["invalid date", { calendarDate: "2026-02-30", proteinGrams: 100 }, "valid YYYY-MM-DD"],
    ["notes only", { calendarDate: "2026-07-30", notes: "estimate" }, "at least one"],
    ["empty", { calendarDate: "2026-07-30" }, "at least one"],
    ["calories", { calendarDate: "2026-07-30", caloriesKcal: 20_001 }, "caloriesKcal"],
    ["protein", { calendarDate: "2026-07-30", proteinGrams: -0.1 }, "proteinGrams"],
    ["carbs", { calendarDate: "2026-07-30", carbsGrams: Infinity }, "carbsGrams"],
    ["fat", { calendarDate: "2026-07-30", fatGrams: 1_001 }, "fatGrams"],
    [
      "notes length",
      { calendarDate: "2026-07-30", caloriesKcal: 1, notes: "x".repeat(501) },
      "notes must be 500 characters or fewer",
    ],
  ])("rejects %s", async (_label, args, message) => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });

    await expect(authed.mutation(api.nutrition.upsertDailyMine, args)).rejects.toThrow(message);
  });

  test("accepts valid four-digit calendar years below 100", async () => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });

    await expect(
      authed.mutation(api.nutrition.upsertDailyMine, {
        calendarDate: "0099-12-31",
        proteinGrams: 100,
      }),
    ).resolves.toMatchObject({ calendarDate: "0099-12-31", proteinGrams: 100 });
  });

  test("lists newest dates with bounded limits", async () => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });
    await testClient.run(async (ctx) => {
      for (let dayOffset = 0; dayOffset < 32; dayOffset += 1) {
        const calendarDate = new Date(Date.UTC(2026, 5, 29 + dayOffset)).toISOString().slice(0, 10);
        await ctx.db.insert("nutritionDailyLogs", {
          userId,
          calendarDate,
          source: "manual",
          caloriesKcal: dayOffset,
          createdAt: dayOffset,
          updatedAt: dayOffset,
        });
      }
    });

    const defaultRows = await authed.query(api.nutrition.listRecentMine, {});
    const maximumRows = await authed.query(api.nutrition.listRecentMine, { limit: 31 });

    expect(defaultRows).toHaveLength(14);
    expect(defaultRows[0]?.calendarDate).toBe("2026-07-30");
    expect(maximumRows).toHaveLength(31);
    expect(maximumRows[30]?.calendarDate).toBe("2026-06-30");
    await expect(authed.query(api.nutrition.listRecentMine, { limit: 32 })).rejects.toThrow(
      "limit must be an integer from 1 to 31",
    );
  });

  test("deletes only the authenticated user's matching date", async () => {
    const testClient = createTest();
    const firstUserId = await createUser(testClient);
    const secondUserId = await createUser(testClient);
    const first = testClient.withIdentity({ subject: `${firstUserId}|session` });
    const second = testClient.withIdentity({ subject: `${secondUserId}|session` });
    await first.mutation(api.nutrition.upsertDailyMine, {
      calendarDate: "2026-07-30",
      proteinGrams: 140,
    });

    await expect(
      second.mutation(api.nutrition.deleteDailyMine, { calendarDate: "2026-07-30" }),
    ).rejects.toThrow("Nutrition daily log not found");
    await expect(
      first.mutation(api.nutrition.deleteDailyMine, { calendarDate: "2026-07-30" }),
    ).resolves.toBeNull();
    await expect(
      first.mutation(api.nutrition.deleteDailyMine, { calendarDate: "2026-07-30" }),
    ).rejects.toThrow("Nutrition daily log not found");
  });

  test("rate limits repeated daily saves", async () => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });
    for (let value = 0; value < 5; value += 1) {
      await authed.mutation(api.nutrition.upsertDailyMine, {
        calendarDate: "2026-07-30",
        caloriesKcal: value,
      });
    }

    await expect(
      authed.mutation(api.nutrition.upsertDailyMine, {
        calendarDate: "2026-07-30",
        caloriesKcal: 6,
      }),
    ).rejects.toThrow();
  });

  test("rate limits repeated daily deletes", async () => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });
    await testClient.run(async (ctx) => {
      for (let day = 1; day <= 6; day += 1) {
        await ctx.db.insert("nutritionDailyLogs", {
          userId,
          calendarDate: `2026-07-0${day}`,
          source: "manual",
          proteinGrams: 100,
          createdAt: day,
          updatedAt: day,
        });
      }
    });
    for (let day = 1; day <= 5; day += 1) {
      await authed.mutation(api.nutrition.deleteDailyMine, { calendarDate: `2026-07-0${day}` });
    }

    await expect(
      authed.mutation(api.nutrition.deleteDailyMine, { calendarDate: "2026-07-06" }),
    ).rejects.toThrow();
  });
});

describe("nutrition targets", () => {
  test("sets one portable self-set target and preserves creation time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T18:00:00.000Z"));
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });

    const created = await authed.mutation(api.nutrition.setTargetsMine, {
      caloriesKcal: 0,
      proteinGrams: 150.5,
    });
    vi.setSystemTime(new Date("2026-07-30T19:00:00.000Z"));
    const updated = await authed.mutation(api.nutrition.setTargetsMine, { fatGrams: 70.25 });

    expect(created).toMatchObject({ source: "self_set", caloriesKcal: 0, proteinGrams: 150.5 });
    expect(updated).toEqual({
      source: "self_set",
      caloriesKcal: null,
      proteinGrams: null,
      carbsGrams: null,
      fatGrams: 70.25,
      createdAt: created.createdAt,
      updatedAt: new Date("2026-07-30T19:00:00.000Z").getTime(),
    });
    await expect(authed.query(api.nutrition.getTargetsMine, {})).resolves.toEqual(updated);
    expect(updated).not.toHaveProperty("_id");
    expect(updated).not.toHaveProperty("userId");
  });

  test("requires a metric, validates bounds, and requires auth for writes", async () => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });

    await expect(testClient.query(api.nutrition.getTargetsMine, {})).resolves.toBeNull();
    await expect(
      testClient.mutation(api.nutrition.setTargetsMine, { proteinGrams: 100 }),
    ).rejects.toThrow("Not authenticated");
    await expect(testClient.mutation(api.nutrition.clearTargetsMine, {})).rejects.toThrow(
      "Not authenticated",
    );
    await expect(authed.mutation(api.nutrition.setTargetsMine, {})).rejects.toThrow("at least one");
    await expect(
      authed.mutation(api.nutrition.setTargetsMine, { caloriesKcal: Number.NaN }),
    ).rejects.toThrow("caloriesKcal");
    await expect(
      authed.mutation(api.nutrition.setTargetsMine, { proteinGrams: 2_001 }),
    ).rejects.toThrow("proteinGrams");
    await expect(authed.mutation(api.nutrition.setTargetsMine, { carbsGrams: -1 })).rejects.toThrow(
      "carbsGrams",
    );
    await expect(
      authed.mutation(api.nutrition.setTargetsMine, { fatGrams: 1_001 }),
    ).rejects.toThrow("fatGrams");
  });

  test("isolates targets and clears idempotently", async () => {
    const testClient = createTest();
    const firstUserId = await createUser(testClient);
    const secondUserId = await createUser(testClient);
    const first = testClient.withIdentity({ subject: `${firstUserId}|session` });
    const second = testClient.withIdentity({ subject: `${secondUserId}|session` });
    await first.mutation(api.nutrition.setTargetsMine, { proteinGrams: 160 });

    await expect(second.query(api.nutrition.getTargetsMine, {})).resolves.toBeNull();
    await expect(second.mutation(api.nutrition.clearTargetsMine, {})).resolves.toBeNull();
    await expect(first.query(api.nutrition.getTargetsMine, {})).resolves.toMatchObject({
      proteinGrams: 160,
    });
    await expect(first.mutation(api.nutrition.clearTargetsMine, {})).resolves.toBeNull();
    await expect(first.mutation(api.nutrition.clearTargetsMine, {})).resolves.toBeNull();
    await expect(first.query(api.nutrition.getTargetsMine, {})).resolves.toBeNull();
  });

  test("rate limits repeated target updates", async () => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });
    for (let value = 0; value < 3; value += 1) {
      await authed.mutation(api.nutrition.setTargetsMine, { caloriesKcal: value });
    }

    await expect(
      authed.mutation(api.nutrition.setTargetsMine, { caloriesKcal: 4 }),
    ).rejects.toThrow();
  });
});
