/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../coach/${key.slice(2)}` : key] = value;
}

describe("advanceWeek", () => {
  it("reports that no advancement occurred without an active block", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));

    const result = await t.mutation(internal.coach.periodization.advanceWeek, { userId });

    expect(result).toEqual({ advanced: false, transitioned: false, newBlock: null });
  });

  it("reports advancement when it increments an active block", async () => {
    const t = convexTest(schema, modules);
    const { blockId, userId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const blockId = await ctx.db.insert("trainingBlocks", {
        userId,
        label: "Building Phase",
        blockType: "building",
        weekNumber: 1,
        totalWeeks: 4,
        startDate: "2026-07-28",
        status: "active",
        createdAt: 1_775_772_000_000,
      });
      return { blockId, userId };
    });

    const result = await t.mutation(internal.coach.periodization.advanceWeek, { userId });
    const block = await t.run((ctx) => ctx.db.get(blockId));

    expect(result).toEqual({ advanced: true, transitioned: false, newBlock: null });
    expect(block?.weekNumber).toBe(2);
  });
});
