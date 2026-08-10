/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

function createTest() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

type TestHarness = ReturnType<typeof createTest>;

async function createUser(t: TestHarness): Promise<Id<"users">> {
  return await t.run(async (ctx) => ctx.db.insert("users", {}));
}

async function createDeletingUser(t: TestHarness): Promise<Id<"users">> {
  return await t.run(async (ctx) => ctx.db.insert("users", { deletionInProgress: true }));
}

async function insertMovement(
  t: TestHarness,
  overrides: { tonalId: string; name: string; muscleGroups?: string[] },
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("movements", {
      tonalId: overrides.tonalId,
      name: overrides.name,
      shortName: overrides.name,
      muscleGroups: overrides.muscleGroups ?? [],
      skillLevel: 1,
      publishState: "published",
      sortOrder: 0,
      onMachine: true,
      inFreeLift: false,
      countReps: true,
      isTwoSided: false,
      isBilateral: true,
      isAlternating: false,
      descriptionHow: "",
      descriptionWhy: "",
      lastSyncedAt: 1,
    });
  });
}

async function insertExclusions(t: TestHarness, userId: Id<"users">, count: number): Promise<void> {
  await t.run(async (ctx) => {
    for (let index = 0; index < count; index += 1) {
      await ctx.db.insert("exerciseExclusions", {
        userId,
        movementId: `existing-${index}`,
        movementName: `Existing ${index}`,
        muscleGroups: ["Legs"],
        createdAt: index,
      });
    }
  });
}

async function countExclusions(t: TestHarness, userId: Id<"users">): Promise<number> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("exerciseExclusions")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(101);
    return rows.length;
  });
}

describe("exerciseExclusions", () => {
  test("adds, lists, and removes an authenticated user's excluded exercise", async () => {
    const t = createTest();
    const userId = await createUser(t);
    const authed = t.withIdentity({ subject: `${userId}|session` });
    await insertMovement(t, {
      tonalId: "movement-bench",
      name: "Bench Press",
      muscleGroups: ["Chest", "Triceps"],
    });

    const added = await authed.mutation(api.exerciseExclusions.addMine, {
      movementId: "movement-bench",
    });
    const listed = await authed.query(api.exerciseExclusions.listMine, {});

    expect(added).toMatchObject({
      movementId: "movement-bench",
      movementName: "Bench Press",
      muscleGroups: ["Chest", "Triceps"],
    });
    expect(listed).toEqual([added]);

    await expect(
      authed.mutation(api.exerciseExclusions.removeMine, { movementId: "movement-bench" }),
    ).resolves.toEqual({ removed: true });
    await expect(authed.query(api.exerciseExclusions.listMine, {})).resolves.toEqual([]);
  });

  test("is idempotent when the same movement is added twice", async () => {
    const t = createTest();
    const userId = await createUser(t);
    const authed = t.withIdentity({ subject: `${userId}|session` });
    await insertMovement(t, { tonalId: "movement-row", name: "Seated Row" });

    const first = await authed.mutation(api.exerciseExclusions.addMine, {
      movementId: "movement-row",
    });
    const second = await authed.mutation(api.exerciseExclusions.addMine, {
      movementId: "movement-row",
    });
    const listed = await authed.query(api.exerciseExclusions.listMine, {});

    expect(second).toEqual(first);
    expect(listed).toHaveLength(1);
  });

  test("allows a twenty-exercise curation burst for adds and removals", async () => {
    const t = createTest();
    const userId = await createUser(t);
    const authed = t.withIdentity({ subject: `${userId}|session` });
    const movementIds = Array.from({ length: 20 }, (_, index) => `movement-${index}`);
    for (const [index, movementId] of movementIds.entries()) {
      await insertMovement(t, { tonalId: movementId, name: `Movement ${index}` });
    }

    for (const movementId of movementIds) {
      await authed.mutation(api.exerciseExclusions.addMine, { movementId });
    }

    await expect(authed.query(api.exerciseExclusions.listMine, {})).resolves.toHaveLength(20);

    for (const movementId of movementIds) {
      await authed.mutation(api.exerciseExclusions.removeMine, { movementId });
    }

    await expect(authed.query(api.exerciseExclusions.listMine, {})).resolves.toEqual([]);
  });

  test("rejects unknown movement IDs", async () => {
    const t = createTest();
    const userId = await createUser(t);
    const authed = t.withIdentity({ subject: `${userId}|session` });

    await expect(
      authed.mutation(api.exerciseExclusions.addMine, { movementId: "missing" }),
    ).rejects.toThrow("Movement not found");
  });

  test("does not expose another user's exclusions", async () => {
    const t = createTest();
    const firstUserId = await createUser(t);
    const secondUserId = await createUser(t);
    const first = t.withIdentity({ subject: `${firstUserId}|session` });
    const second = t.withIdentity({ subject: `${secondUserId}|session` });
    await insertMovement(t, { tonalId: "movement-curl", name: "Bicep Curl" });

    await first.mutation(api.exerciseExclusions.addMine, { movementId: "movement-curl" });

    await expect(second.query(api.exerciseExclusions.listMine, {})).resolves.toEqual([]);
    await expect(
      second.mutation(api.exerciseExclusions.removeMine, { movementId: "movement-curl" }),
    ).resolves.toEqual({ removed: false });
  });

  test("internal query returns stored exclusions for programming paths", async () => {
    const t = createTest();
    const userId = await createUser(t);

    await t.run(async (ctx) => {
      await ctx.db.insert("exerciseExclusions", {
        userId,
        movementId: "movement-squat",
        movementName: "Squat",
        muscleGroups: ["Quads", "Glutes"],
        createdAt: 1000,
      });
    });

    const exclusions = await t.query(internal.exerciseExclusions.getForUser, { userId });

    expect(exclusions).toEqual([
      {
        movementId: "movement-squat",
        movementName: "Squat",
        muscleGroups: ["Quads", "Glutes"],
        createdAt: 1000,
      },
    ]);
  });

  test("rejects an over-cap batch without partially inserting it", async () => {
    const t = createTest();
    const userId = await createUser(t);
    await insertExclusions(t, userId, 99);
    await insertMovement(t, { tonalId: "new-a", name: "New A" });
    await insertMovement(t, { tonalId: "new-b", name: "New B" });

    await expect(
      t.mutation(internal.exerciseExclusions.addManyForUser, {
        userId,
        movementIds: ["new-a", "new-b"],
      }),
    ).rejects.toThrow("Maximum 100 excluded exercises");

    await expect(countExclusions(t, userId)).resolves.toBe(99);
    const rows = await t.run(async (ctx) => {
      return await Promise.all([
        ctx.db
          .query("exerciseExclusions")
          .withIndex("by_userId_movementId", (q) =>
            q.eq("userId", userId).eq("movementId", "new-a"),
          )
          .unique(),
        ctx.db
          .query("exerciseExclusions")
          .withIndex("by_userId_movementId", (q) =>
            q.eq("userId", userId).eq("movementId", "new-b"),
          )
          .unique(),
      ]);
    });
    expect(rows).toEqual([null, null]);
  });

  test("keeps add, remove, and read paths inert while account deletion is in progress", async () => {
    const t = createTest();
    const userId = await createDeletingUser(t);
    await insertMovement(t, { tonalId: "new-movement", name: "New Movement" });
    await t.run(async (ctx) => {
      await ctx.db.insert("exerciseExclusions", {
        userId,
        movementId: "existing-movement",
        movementName: "Existing Movement",
        muscleGroups: ["Back"],
        createdAt: 1,
      });
    });

    await expect(
      t.mutation(internal.exerciseExclusions.addManyForUser, {
        userId,
        movementIds: ["new-movement"],
      }),
    ).rejects.toThrow("Account deletion in progress");
    await expect(
      t.mutation(internal.exerciseExclusions.removeManyForUser, {
        userId,
        movementIds: ["existing-movement"],
      }),
    ).rejects.toThrow("Account deletion in progress");
    await expect(t.query(internal.exerciseExclusions.getForUser, { userId })).resolves.toEqual([]);

    await expect(countExclusions(t, userId)).resolves.toBe(1);
  });

  test("allows an idempotent existing ID plus one new ID at the cap", async () => {
    const t = createTest();
    const userId = await createUser(t);
    await insertExclusions(t, userId, 99);
    await insertMovement(t, { tonalId: "new-movement", name: "New Movement" });

    const result = await t.mutation(internal.exerciseExclusions.addManyForUser, {
      userId,
      movementIds: [" existing-0 ", "new-movement", "new-movement"],
    });

    expect(result.map((exclusion) => exclusion.movementId)).toEqual(["existing-0", "new-movement"]);
    await expect(countExclusions(t, userId)).resolves.toBe(100);
  });
});
