/// <reference types="vite/client" />
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { USER_TABLE_BATCH_TABLES } from "./userData";

const modules = import.meta.glob("./**/*.*s");

function createTest() {
  const testClient = convexTest(schema, modules);
  registerRateLimiter(testClient);
  return testClient;
}

async function createUser(testClient: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await testClient.run(async (ctx) => ctx.db.insert("users", {}));
}

async function insertSession(
  testClient: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  marker: number,
): Promise<Id<"liftingSessions">> {
  return await testClient.run(async (ctx) =>
    ctx.db.insert("liftingSessions", {
      userId,
      source: "manual",
      performedAt: marker,
      calendarDate: "2026-07-30",
      title: `Session ${marker}`,
      exerciseCount: 0,
      setCount: 0,
      totalReps: 0,
      totalVolumeLbs: 0,
      createdAt: marker,
      updatedAt: marker,
    }),
  );
}

async function insertSessionTree(
  testClient: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  marker: number,
) {
  return await testClient.run(async (ctx) => {
    const sessionId = await ctx.db.insert("liftingSessions", {
      userId,
      source: "manual",
      performedAt: marker,
      calendarDate: "2026-07-30",
      title: `Session ${marker}`,
      exerciseCount: 1,
      setCount: 1,
      totalReps: 5,
      totalVolumeLbs: 500,
      createdAt: marker,
      updatedAt: marker,
    });
    const exerciseId = await ctx.db.insert("liftingExercises", {
      userId,
      sessionId,
      order: 0,
      name: "Squat",
      setCount: 1,
      totalReps: 5,
      totalVolumeLbs: 500,
    });
    await ctx.db.insert("liftingSets", {
      userId,
      sessionId,
      exerciseId,
      exerciseOrder: 0,
      order: 0,
      kind: "working",
      reps: 5,
      weightLbs: 100,
    });
    return { sessionId, exerciseId };
  });
}

describe("lifting session security and lifecycle", () => {
  test("keeps list results isolated by authenticated owner", async () => {
    const testClient = createTest();
    const firstUserId = await createUser(testClient);
    const secondUserId = await createUser(testClient);
    await insertSession(testClient, firstUserId, 1);
    await insertSession(testClient, secondUserId, 2);

    const firstRows = await testClient
      .withIdentity({ subject: `${firstUserId}|session` })
      .query(api.liftingSessions.listMine, {});
    const secondRows = await testClient
      .withIdentity({ subject: `${secondUserId}|session` })
      .query(api.liftingSessions.listMine, {});

    expect(firstRows.map((row) => row.title)).toEqual(["Session 1"]);
    expect(secondRows.map((row) => row.title)).toEqual(["Session 2"]);
  });

  test("rejects an unauthenticated delete", async () => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const sessionId = await insertSession(testClient, userId, 1);

    await expect(
      testClient.mutation(api.liftingSessions.deleteMine, { sessionId }),
    ).rejects.toThrow("Not authenticated");
  });

  test("rate limits repeated deletes for one user", async () => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const sessionIds: Id<"liftingSessions">[] = [];
    for (let marker = 1; marker <= 6; marker += 1) {
      sessionIds.push(await insertSession(testClient, userId, marker));
    }
    const authed = testClient.withIdentity({ subject: `${userId}|session` });

    for (const sessionId of sessionIds.slice(0, 5)) {
      await authed.mutation(api.liftingSessions.deleteMine, { sessionId });
    }

    await expect(
      authed.mutation(api.liftingSessions.deleteMine, { sessionId: sessionIds[5]! }),
    ).rejects.toThrow();
  });

  test("account deletion drains sets, exercises, then sessions without touching another user", async () => {
    const testClient = createTest();
    const targetUserId = await createUser(testClient);
    const otherUserId = await createUser(testClient);
    await insertSessionTree(testClient, targetUserId, 1);
    const other = await insertSessionTree(testClient, otherUserId, 2);
    const liftingTables = USER_TABLE_BATCH_TABLES.filter(
      (table) =>
        table === "liftingSets" || table === "liftingExercises" || table === "liftingSessions",
    );

    expect(liftingTables).toEqual(["liftingSets", "liftingExercises", "liftingSessions"]);
    for (const table of liftingTables) {
      await testClient.mutation(internal.accountDeletion.deleteUserTableBatch, {
        userId: targetUserId,
        table,
      });
    }

    const remaining = await testClient.run(async (ctx) => ({
      sessions: await ctx.db.query("liftingSessions").collect(),
      exercises: await ctx.db.query("liftingExercises").collect(),
      sets: await ctx.db.query("liftingSets").collect(),
    }));
    expect(remaining.sessions.map((row) => row._id)).toEqual([other.sessionId]);
    expect(remaining.exercises.map((row) => row._id)).toEqual([other.exerciseId]);
    expect(remaining.sets).toHaveLength(1);
    expect(remaining.sets[0]?.userId).toBe(otherUserId);
  });
});
