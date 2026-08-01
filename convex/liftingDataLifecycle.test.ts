/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { USER_DATA_TABLES } from "./userData";

const modules = import.meta.glob("./**/*.*s");

async function createUser(testClient: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await testClient.run(async (ctx) => ctx.db.insert("users", {}));
}

describe("manual lifting data lifecycle", () => {
  test("exports an owned lifting session tree as portable ordered JSON", async () => {
    const testClient = convexTest(schema, modules);
    const userId = await createUser(testClient);
    const otherUserId = await createUser(testClient);

    await testClient.run(async (ctx) => {
      const sessionId = await ctx.db.insert("liftingSessions", {
        userId,
        source: "manual",
        performedAt: 200,
        calendarDate: "2026-07-30",
        title: "Garage strength",
        durationMinutes: 55,
        notes: "Felt strong",
        exerciseCount: 2,
        setCount: 3,
        totalReps: 23,
        totalVolumeLbs: 1_685,
        createdAt: 210,
        updatedAt: 220,
      });
      const pullUpId = await ctx.db.insert("liftingExercises", {
        userId,
        sessionId,
        order: 1,
        name: "Pull-up",
        setCount: 1,
        totalReps: 10,
        totalVolumeLbs: 0,
      });
      const squatId = await ctx.db.insert("liftingExercises", {
        userId,
        sessionId,
        order: 0,
        name: "Barbell squat",
        setCount: 2,
        totalReps: 13,
        totalVolumeLbs: 1_685,
      });
      await ctx.db.insert("liftingSets", {
        userId,
        sessionId,
        exerciseId: squatId,
        exerciseOrder: 0,
        order: 1,
        kind: "working",
        reps: 5,
        weightLbs: 185,
        rpe: 8,
      });
      await ctx.db.insert("liftingSets", {
        userId,
        sessionId,
        exerciseId: pullUpId,
        exerciseOrder: 1,
        order: 0,
        kind: "working",
        reps: 10,
      });
      await ctx.db.insert("liftingSets", {
        userId,
        sessionId,
        exerciseId: squatId,
        exerciseOrder: 0,
        order: 0,
        kind: "warmup",
        reps: 8,
        weightLbs: 95,
      });
      await ctx.db.insert("liftingSessions", {
        userId: otherUserId,
        source: "manual",
        performedAt: 100,
        calendarDate: "2026-07-29",
        title: "Other user's session",
        exerciseCount: 0,
        setCount: 0,
        totalReps: 0,
        totalVolumeLbs: 0,
        createdAt: 100,
        updatedAt: 100,
      });
    });

    const data = await testClient
      .withIdentity({ subject: `${userId}|session` })
      .action(api.dataExport.exportData, {});

    expect(data).toMatchObject({
      liftingSessions: [
        {
          source: "manual",
          performedAt: 200,
          calendarDate: "2026-07-30",
          title: "Garage strength",
          durationMinutes: 55,
          notes: "Felt strong",
          exerciseCount: 2,
          setCount: 3,
          totalReps: 23,
          totalVolumeLbs: 1_685,
          createdAt: 210,
          updatedAt: 220,
          exercises: [
            {
              name: "Barbell squat",
              order: 0,
              setCount: 2,
              totalReps: 13,
              totalVolumeLbs: 1_685,
              sets: [
                { order: 0, kind: "warmup", reps: 8, weightLbs: 95, rpe: null },
                { order: 1, kind: "working", reps: 5, weightLbs: 185, rpe: 8 },
              ],
            },
            {
              name: "Pull-up",
              order: 1,
              setCount: 1,
              totalReps: 10,
              totalVolumeLbs: 0,
              sets: [{ order: 0, kind: "working", reps: 10, weightLbs: null, rpe: null }],
            },
          ],
        },
      ],
    });
    const exportedSession = data.liftingSessions[0];
    const exportedExercise = exportedSession?.exercises[0];
    const exportedSet = exportedExercise?.sets[0];

    expect(exportedSession).not.toHaveProperty("_id");
    expect(exportedSession).not.toHaveProperty("_creationTime");
    expect(exportedSession).not.toHaveProperty("userId");
    expect(exportedExercise).not.toHaveProperty("sessionId");
    expect(exportedSet).not.toHaveProperty("exerciseId");
    expect(JSON.stringify(data.liftingSessions)).not.toContain("Other user's session");
  });

  test("exports an empty lifting collection when the user has no manual sessions", async () => {
    const testClient = convexTest(schema, modules);
    const userId = await createUser(testClient);

    const data = await testClient
      .withIdentity({ subject: `${userId}|session` })
      .action(api.dataExport.exportData, {});

    expect(data.liftingSessions).toEqual([]);
  });

  test("exports every set when a session spans more than one export page", async () => {
    const testClient = convexTest(schema, modules);
    const userId = await createUser(testClient);
    await testClient.run(async (ctx) => {
      const sessionId = await ctx.db.insert("liftingSessions", {
        userId,
        source: "manual",
        performedAt: 300,
        calendarDate: "2026-07-30",
        title: "Pagination session",
        exerciseCount: 1,
        setCount: 501,
        totalReps: 501,
        totalVolumeLbs: 0,
        createdAt: 300,
        updatedAt: 300,
      });
      const exerciseId = await ctx.db.insert("liftingExercises", {
        userId,
        sessionId,
        order: 0,
        name: "Bodyweight squat",
        setCount: 501,
        totalReps: 501,
        totalVolumeLbs: 0,
      });
      for (let order = 0; order < 501; order += 1) {
        await ctx.db.insert("liftingSets", {
          userId,
          sessionId,
          exerciseId,
          exerciseOrder: 0,
          order,
          kind: "working",
          reps: 1,
        });
      }
    });

    const data = await testClient
      .withIdentity({ subject: `${userId}|session` })
      .action(api.dataExport.exportData, {});
    const sets = data.liftingSessions[0]?.exercises[0]?.sets;

    expect(sets).toHaveLength(501);
    expect(sets?.[0]?.order).toBe(0);
    expect(sets?.[500]?.order).toBe(500);
  });

  test("registers lifting sessions as a JSON export section", () => {
    expect(USER_DATA_TABLES.find((entry) => entry.table === "liftingSessions")).toEqual({
      table: "liftingSessions",
      delete: "byUserIdBatch",
      jsonExportKey: "liftingSessions",
    });
  });

  test("preserves the public export authentication requirement", async () => {
    const testClient = convexTest(schema, modules);

    await expect(testClient.action(api.dataExport.exportData, {})).rejects.toThrow(
      "Not authenticated",
    );
  });
});
