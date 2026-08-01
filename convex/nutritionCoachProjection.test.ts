/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { readNutritionSnapshot } from "./nutritionCoachProjection";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("nutrition coach projection", () => {
  test("returns only the owner's seven newest days without notes or identifiers", async () => {
    const t = convexTest(schema, modules);
    const [userId, otherUserId] = await t.run(async (ctx) =>
      Promise.all([ctx.db.insert("users", {}), ctx.db.insert("users", {})]),
    );

    await t.run(async (ctx) => {
      for (let day = 1; day <= 8; day += 1) {
        await ctx.db.insert("nutritionDailyLogs", {
          userId,
          calendarDate: `2026-07-${String(day).padStart(2, "0")}`,
          source: "manual",
          caloriesKcal: 2_000 + day,
          proteinGrams: day === 8 ? 0 : 150,
          notes: `private note ${day}`,
          createdAt: day,
          updatedAt: day,
        });
      }
      await ctx.db.insert("nutritionDailyLogs", {
        userId: otherUserId,
        calendarDate: "2026-07-31",
        source: "manual",
        caloriesKcal: 9_999,
        notes: "other user's private note",
        createdAt: 31,
        updatedAt: 31,
      });
      await ctx.db.insert("nutritionTargets", {
        userId,
        source: "self_set",
        caloriesKcal: 2_400,
        proteinGrams: 180,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("nutritionTargets", {
        userId: otherUserId,
        source: "self_set",
        caloriesKcal: 8_888,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const snapshot = await t.run((ctx) => readNutritionSnapshot(ctx, userId));

    expect(snapshot.days).toHaveLength(7);
    expect(snapshot.days.map((day) => day.calendarDate)).toEqual([
      "2026-07-08",
      "2026-07-07",
      "2026-07-06",
      "2026-07-05",
      "2026-07-04",
      "2026-07-03",
      "2026-07-02",
    ]);
    expect(snapshot.days[0]).toEqual({
      calendarDate: "2026-07-08",
      caloriesKcal: 2_008,
      proteinGrams: 0,
      updatedAt: 8,
    });
    expect(snapshot.targets).toEqual({
      caloriesKcal: 2_400,
      proteinGrams: 180,
    });
    for (const day of snapshot.days) {
      expect(day).not.toHaveProperty("_id");
      expect(day).not.toHaveProperty("userId");
      expect(day).not.toHaveProperty("notes");
    }
    expect(snapshot.targets).not.toHaveProperty("_id");
    expect(snapshot.targets).not.toHaveProperty("userId");
    expect(JSON.stringify(snapshot)).not.toContain("private note");
    expect(JSON.stringify(snapshot)).not.toContain(String(userId));
    expect(JSON.stringify(snapshot)).not.toContain("9999");
    expect(JSON.stringify(snapshot)).not.toContain("8888");
  });

  test("returns explicit empty state when the user has no nutrition data", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    const snapshot = await t.run((ctx) => readNutritionSnapshot(ctx, userId));

    expect(snapshot).toEqual({ days: [], targets: null });
  });

  test("returns no nutrition context while account deletion is in progress", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { deletionInProgress: true }));
    await t.run(async (ctx) => {
      await ctx.db.insert("nutritionDailyLogs", {
        userId,
        calendarDate: "2026-07-30",
        source: "manual",
        caloriesKcal: 2_000,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("nutritionTargets", {
        userId,
        source: "self_set",
        proteinGrams: 160,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const inputs = await t.query(internal.coachState.gatherSnapshotInputs, { userId });

    expect(inputs.deletionInProgress).toBe(true);
    expect(inputs.nutrition).toEqual({ days: [], targets: null });
  });

  test("falls back to empty nutrition context when its source read fails", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.run(async (ctx) => {
      for (let index = 0; index < 2; index += 1) {
        await ctx.db.insert("nutritionTargets", {
          userId,
          source: "self_set",
          proteinGrams: 160 + index,
          createdAt: index,
          updatedAt: index,
        });
      }
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const inputs = await t.query(internal.coachState.gatherSnapshotInputs, { userId });

    expect(inputs.nutrition).toEqual({ days: [], targets: null });
    expect(errorSpy).toHaveBeenCalledWith(
      "gatherSnapshotInputs: nutrition read failed",
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
});
