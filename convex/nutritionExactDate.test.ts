/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("nutrition exact-date reads", () => {
  test("returns only the authenticated user's matching date", async () => {
    const testClient = convexTest(schema, modules);
    const [userId, otherUserId] = await testClient.run(async (ctx) =>
      Promise.all([ctx.db.insert("users", {}), ctx.db.insert("users", {})]),
    );
    await testClient.run(async (ctx) => {
      await ctx.db.insert("nutritionDailyLogs", {
        userId,
        calendarDate: "2026-01-01",
        source: "manual",
        proteinGrams: 150,
        notes: "owner note",
        createdAt: 1,
        updatedAt: 2,
      });
      await ctx.db.insert("nutritionDailyLogs", {
        userId: otherUserId,
        calendarDate: "2026-01-01",
        source: "manual",
        proteinGrams: 999,
        notes: "other note",
        createdAt: 1,
        updatedAt: 2,
      });
    });
    const authed = testClient.withIdentity({ subject: `${userId}|session` });
    const other = testClient.withIdentity({ subject: `${otherUserId}|session` });

    await expect(
      authed.query(api.nutrition.getDailyMine, { calendarDate: "2026-01-01" }),
    ).resolves.toMatchObject({ proteinGrams: 150, notes: "owner note" });
    await expect(
      other.query(api.nutrition.getDailyMine, { calendarDate: "2026-01-02" }),
    ).resolves.toBeNull();
    await expect(
      testClient.query(api.nutrition.getDailyMine, { calendarDate: "2026-01-01" }),
    ).resolves.toBeNull();
  });

  test("rejects invalid authenticated calendar dates", async () => {
    const testClient = convexTest(schema, modules);
    const userId = await testClient.run(async (ctx) => ctx.db.insert("users", {}));
    const authed = testClient.withIdentity({ subject: `${userId}|session` });

    await expect(
      authed.query(api.nutrition.getDailyMine, { calendarDate: "2026-02-30" }),
    ).rejects.toThrow("calendarDate must be a valid YYYY-MM-DD date");
  });
});
