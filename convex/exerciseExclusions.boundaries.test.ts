/// <reference types="vite/client" />
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
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

async function createUser(t: TestHarness, deletionInProgress = false): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", deletionInProgress ? { deletionInProgress: true } : {}),
  );
}

async function insertMovement(t: TestHarness, tonalId: string): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("movements", {
      tonalId,
      name: tonalId,
      shortName: tonalId,
      muscleGroups: ["Legs"],
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

async function insertExclusion(
  t: TestHarness,
  userId: Id<"users">,
  movementId: string,
  createdAt: number,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("exerciseExclusions", {
      userId,
      movementId,
      movementName: movementId,
      muscleGroups: ["Legs"],
      createdAt,
    });
  });
}

async function listStored(t: TestHarness, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("exerciseExclusions")
      .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
      .take(102);
  });
}

describe("exercise exclusion batch boundaries", () => {
  test("bounds both add and remove batches before any write", async () => {
    const t = createTest();
    const userId = await createUser(t);
    const movementIds = Array.from({ length: 13 }, (_, index) => `movement-${index}`);

    await expect(
      t.mutation(internal.exerciseExclusions.addManyForUser, { userId, movementIds }),
    ).rejects.toThrow("Maximum 12 exercises per call");
    await expect(
      t.mutation(internal.exerciseExclusions.removeManyForUser, { userId, movementIds }),
    ).rejects.toThrow("Maximum 12 exercises per call");

    await expect(listStored(t, userId)).resolves.toEqual([]);
  });

  test("rejects a mixed unknown batch without inserting its valid movement", async () => {
    const t = createTest();
    const userId = await createUser(t);
    await insertMovement(t, "known");

    await expect(
      t.mutation(internal.exerciseExclusions.addManyForUser, {
        userId,
        movementIds: ["known", "missing"],
      }),
    ).rejects.toThrow("Movement not found: missing");

    await expect(listStored(t, userId)).resolves.toEqual([]);
  });

  test("does not make an existing stale ID consume capacity", async () => {
    const t = createTest();
    const userId = await createUser(t);
    for (let index = 0; index < 101; index += 1) {
      await insertExclusion(t, userId, `existing-${index}`, index);
    }

    const result = await t.mutation(internal.exerciseExclusions.addManyForUser, {
      userId,
      movementIds: [" existing-0 ", "existing-0"],
    });

    expect(result.map((row) => row.movementId)).toEqual(["existing-0"]);
    await expect(listStored(t, userId)).resolves.toHaveLength(101);
  });

  test("removes deduplicated stored IDs without consulting the movement catalog", async () => {
    const t = createTest();
    const userId = await createUser(t);
    await insertExclusion(t, userId, "stale-id", 1);

    const result = await t.mutation(internal.exerciseExclusions.removeManyForUser, {
      userId,
      movementIds: [" stale-id ", "stale-id", "not-excluded"],
    });

    expect(result.map((row) => row.movementId)).toEqual(["stale-id"]);
    await expect(listStored(t, userId)).resolves.toEqual([]);
  });

  test("keeps public reads and writes inert once account deletion starts", async () => {
    const t = createTest();
    const userId = await createUser(t, true);
    const authed = t.withIdentity({ subject: `${userId}|session` });
    await insertMovement(t, "new-movement");
    await insertExclusion(t, userId, "existing", 1);

    await expect(authed.query(api.exerciseExclusions.listMine, {})).resolves.toEqual([]);
    await expect(
      authed.mutation(api.exerciseExclusions.addMine, { movementId: "new-movement" }),
    ).rejects.toThrow("Not authenticated");
    await expect(
      authed.mutation(api.exerciseExclusions.removeMine, { movementId: "existing" }),
    ).rejects.toThrow("Not authenticated");

    await expect(listStored(t, userId)).resolves.toHaveLength(1);
  });

  test("does not recreate orphaned exclusions after the user row is gone", async () => {
    const t = createTest();
    const userId = await createUser(t);
    await insertMovement(t, "new-movement");
    await t.run(async (ctx) => ctx.db.delete(userId));

    await expect(
      t.mutation(internal.exerciseExclusions.addManyForUser, {
        userId,
        movementIds: ["new-movement"],
      }),
    ).rejects.toThrow("Account deletion in progress");
    await expect(
      t.mutation(internal.exerciseExclusions.removeManyForUser, {
        userId,
        movementIds: ["new-movement"],
      }),
    ).rejects.toThrow("Account deletion in progress");
    await expect(t.query(internal.exerciseExclusions.getForUser, { userId })).resolves.toEqual([]);
    await expect(listStored(t, userId)).resolves.toEqual([]);
  });
});
