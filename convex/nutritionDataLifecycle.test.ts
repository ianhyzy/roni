/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { USER_DATA_TABLES } from "./userData";

const modules = import.meta.glob("./**/*.*s");

async function createUser(testClient: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await testClient.run(async (ctx) => ctx.db.insert("users", {}));
}

function calendarDateForOffset(offset: number): string {
  return new Date(Date.UTC(2025, 0, offset + 1)).toISOString().slice(0, 10);
}

describe("nutrition data lifecycle", () => {
  test("exports every owned nutrition row as portable ordered JSON", async () => {
    const testClient = convexTest(schema, modules);
    const userId = await createUser(testClient);
    const otherUserId = await createUser(testClient);
    await testClient.run(async (ctx) => {
      await ctx.db.insert("nutritionDailyLogs", {
        userId,
        calendarDate: "2026-07-31",
        source: "manual",
        caloriesKcal: 2_200,
        notes: "Estimated total",
        createdAt: 30,
        updatedAt: 40,
      });
      await ctx.db.insert("nutritionDailyLogs", {
        userId,
        calendarDate: "2026-07-30",
        source: "manual",
        proteinGrams: 140.5,
        createdAt: 10,
        updatedAt: 20,
      });
      await ctx.db.insert("nutritionTargets", {
        userId,
        source: "self_set",
        caloriesKcal: 2_400,
        proteinGrams: 160,
        createdAt: 300,
        updatedAt: 310,
      });
      await ctx.db.insert("nutritionTargets", {
        userId,
        source: "self_set",
        carbsGrams: 250.25,
        fatGrams: 70,
        createdAt: 100,
        updatedAt: 110,
      });
      await ctx.db.insert("nutritionDailyLogs", {
        userId: otherUserId,
        calendarDate: "2026-07-29",
        source: "manual",
        caloriesKcal: 9_999,
        notes: "Other user data",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("nutritionTargets", {
        userId: otherUserId,
        source: "self_set",
        proteinGrams: 999,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const data = await testClient
      .withIdentity({ subject: `${userId}|session` })
      .action(api.dataExport.exportData, {});

    expect(data.nutritionDailyLogs).toEqual([
      {
        calendarDate: "2026-07-30",
        source: "manual",
        caloriesKcal: null,
        proteinGrams: 140.5,
        carbsGrams: null,
        fatGrams: null,
        notes: null,
        createdAt: 10,
        updatedAt: 20,
      },
      {
        calendarDate: "2026-07-31",
        source: "manual",
        caloriesKcal: 2_200,
        proteinGrams: null,
        carbsGrams: null,
        fatGrams: null,
        notes: "Estimated total",
        createdAt: 30,
        updatedAt: 40,
      },
    ]);
    expect(data.nutritionTargets).toEqual([
      {
        source: "self_set",
        caloriesKcal: null,
        proteinGrams: null,
        carbsGrams: 250.25,
        fatGrams: 70,
        createdAt: 100,
        updatedAt: 110,
      },
      {
        source: "self_set",
        caloriesKcal: 2_400,
        proteinGrams: 160,
        carbsGrams: null,
        fatGrams: null,
        createdAt: 300,
        updatedAt: 310,
      },
    ]);
    for (const row of [...data.nutritionDailyLogs, ...data.nutritionTargets]) {
      expect(row).not.toHaveProperty("_id");
      expect(row).not.toHaveProperty("_creationTime");
      expect(row).not.toHaveProperty("userId");
    }
    expect(JSON.stringify(data.nutritionDailyLogs)).not.toContain("Other user data");
    expect(JSON.stringify(data.nutritionTargets)).not.toContain("999");
  });

  test("returns empty nutrition placeholders before the action collector runs", async () => {
    const testClient = convexTest(schema, modules);
    const userId = await createUser(testClient);

    const collected = await testClient.query(internal.dataExport.collectUserData, { userId });
    const exported = await testClient
      .withIdentity({ subject: `${userId}|session` })
      .action(api.dataExport.exportData, {});

    expect(collected.nutritionDailyLogs).toEqual([]);
    expect(collected.nutritionTargets).toEqual([]);
    expect(exported.nutritionDailyLogs).toEqual([]);
    expect(exported.nutritionTargets).toEqual([]);
  });

  test("exports more than one page of daily logs in ascending calendar order", async () => {
    const testClient = convexTest(schema, modules);
    const userId = await createUser(testClient);
    await testClient.run(async (ctx) => {
      for (let offset = 500; offset >= 0; offset -= 1) {
        await ctx.db.insert("nutritionDailyLogs", {
          userId,
          calendarDate: calendarDateForOffset(offset),
          source: "manual",
          proteinGrams: offset,
          createdAt: offset,
          updatedAt: offset,
        });
      }
    });

    const data = await testClient
      .withIdentity({ subject: `${userId}|session` })
      .action(api.dataExport.exportData, {});

    expect(data.nutritionDailyLogs).toHaveLength(501);
    expect(data.nutritionDailyLogs[0]?.calendarDate).toBe(calendarDateForOffset(0));
    expect(data.nutritionDailyLogs[500]?.calendarDate).toBe(calendarDateForOffset(500));
  });

  test("registers both nutrition tables as JSON export sections", () => {
    expect(USER_DATA_TABLES.find((entry) => entry.table === "nutritionDailyLogs")).toEqual({
      table: "nutritionDailyLogs",
      delete: "byUserIdBatch",
      jsonExportKey: "nutritionDailyLogs",
    });
    expect(USER_DATA_TABLES.find((entry) => entry.table === "nutritionTargets")).toEqual({
      table: "nutritionTargets",
      delete: "byUserIdBatch",
      jsonExportKey: "nutritionTargets",
    });
  });

  test("preserves the public export authentication requirement", async () => {
    const testClient = convexTest(schema, modules);

    await expect(testClient.action(api.dataExport.exportData, {})).rejects.toThrow(
      "Not authenticated",
    );
  });
});
