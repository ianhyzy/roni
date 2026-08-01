/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("recovery data lifecycle", () => {
  test("exports recovery preference and check-ins without Convex metadata", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {});
      await ctx.db.insert("userProfiles", {
        userId: id,
        tonalUserId: "tonal-user",
        tonalToken: "encrypted",
        lastActiveAt: 10,
        preferredRecoverySource: "fitbit",
      });
      await ctx.db.insert("recoveryCheckIns", {
        userId: id,
        calendarDate: "2026-07-30",
        energy: 4,
        soreness: 2,
        stress: 3,
        notes: "Ready to train",
        createdAt: 10,
        updatedAt: 20,
      });
      return id;
    });

    const data = await t.query(internal.dataExport.collectUserData, { userId });

    expect(data.profile?.preferredRecoverySource).toBe("fitbit");
    expect(data.recoveryCheckIns).toEqual([
      {
        calendarDate: "2026-07-30",
        energy: 4,
        soreness: 2,
        stress: 3,
        notes: "Ready to train",
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
  });

  test("deletes only the requested user's recovery check-ins", async () => {
    const t = convexTest(schema, modules);
    const [targetUserId, otherUserId] = await t.run(async (ctx) => {
      const target = await ctx.db.insert("users", {});
      const other = await ctx.db.insert("users", {});
      for (const userId of [target, other]) {
        await ctx.db.insert("recoveryCheckIns", {
          userId,
          calendarDate: "2026-07-30",
          energy: 3,
          soreness: 3,
          stress: 3,
          createdAt: 10,
          updatedAt: 10,
        });
      }
      return [target, other] as const;
    });

    await t.mutation(internal.accountDeletion.deleteUserTableBatch, {
      userId: targetUserId,
      table: "recoveryCheckIns",
    });

    const remaining = await t.run(async (ctx) => ctx.db.query("recoveryCheckIns").collect());
    expect(remaining.map((row) => row.userId)).toEqual([otherUserId]);
  });
});
