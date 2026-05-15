/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { Doc } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");

async function seedWeekPlan(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
): Promise<Id<"weekPlans">> {
  return t.run(async (ctx) =>
    ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: "2026-04-20",
      preferredSplit: "ppl",
      targetDays: 3,
      days: Array.from({ length: 7 }, () => ({
        sessionType: "rest" as const,
        status: "programmed" as const,
      })),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedWorkoutPlan(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
): Promise<Id<"workoutPlans">> {
  return t.run(async (ctx) =>
    ctx.db.insert("workoutPlans", {
      userId,
      title: "Test Workout",
      blocks: [],
      status: "draft" as const,
      source: "roni" as const,
      createdAt: Date.now(),
    }),
  );
}

describe("linkWorkoutPlanToDayInternal", () => {
  test("links a workout plan to a day and returns the week plan id", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, userId);
    const workoutPlanId = await seedWorkoutPlan(t, userId);

    const result = await t.mutation(internal.weekPlanInternals.linkWorkoutPlanToDayInternal, {
      userId,
      weekPlanId,
      dayIndex: 0,
      workoutPlanId,
    });

    expect(result).toBe(weekPlanId);
    const plan = (await t.run(async (ctx) => ctx.db.get(weekPlanId))) as Doc<"weekPlans">;
    expect(plan.days[0].workoutPlanId).toBe(workoutPlanId);
  });

  test("returns null when week plan does not exist (concurrent-delete race)", async () => {
    // Regression for TONALCOACH-12/11: when generateDraftWeekPlan races with
    // another concurrent call that already deleted/recreated the week plan,
    // linkWorkoutPlanToDayInternal must return null instead of throwing so the
    // caller can clean up the orphaned draft and retry gracefully.
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const workoutPlanId = await seedWorkoutPlan(t, userId);
    // Create and immediately delete the week plan to simulate concurrent deletion.
    const weekPlanId = await seedWeekPlan(t, userId);
    await t.mutation(internal.weekPlanInternals.deleteWeekPlanInternal, { userId, weekPlanId });

    const result = await t.mutation(internal.weekPlanInternals.linkWorkoutPlanToDayInternal, {
      userId,
      weekPlanId,
      dayIndex: 0,
      workoutPlanId,
    });

    expect(result).toBeNull();
  });

  test("returns null when week plan belongs to a different user", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const attackerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, ownerId);
    const workoutPlanId = await seedWorkoutPlan(t, attackerId);

    const result = await t.mutation(internal.weekPlanInternals.linkWorkoutPlanToDayInternal, {
      userId: attackerId,
      weekPlanId,
      dayIndex: 0,
      workoutPlanId,
    });

    expect(result).toBeNull();
  });

  test("throws for invalid dayIndex", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, userId);
    const workoutPlanId = await seedWorkoutPlan(t, userId);

    await expect(
      t.mutation(internal.weekPlanInternals.linkWorkoutPlanToDayInternal, {
        userId,
        weekPlanId,
        dayIndex: 7,
        workoutPlanId,
      }),
    ).rejects.toThrow("dayIndex must be 0");
  });
});

describe("deleteWeekPlanInternal", () => {
  test("deletes a week plan that belongs to the user", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, userId);

    await t.mutation(internal.weekPlanInternals.deleteWeekPlanInternal, { userId, weekPlanId });

    const plan = await t.run(async (ctx) => ctx.db.get(weekPlanId));
    expect(plan).toBeNull();
  });

  test("returns without error when the plan is already gone (race-condition no-op)", async () => {
    // Regression for TONALCOACH-12/11: two concurrent generateDraftWeekPlan
    // calls both query the existing plan, then both try to delete it. The
    // second delete must silently succeed, not throw.
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, userId);

    await t.mutation(internal.weekPlanInternals.deleteWeekPlanInternal, { userId, weekPlanId });
    // Second call with the same ID — plan is already gone.
    await expect(
      t.mutation(internal.weekPlanInternals.deleteWeekPlanInternal, { userId, weekPlanId }),
    ).resolves.not.toThrow();
  });

  test("throws when the plan belongs to a different user (access denied)", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const attackerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, ownerId);

    await expect(
      t.mutation(internal.weekPlanInternals.deleteWeekPlanInternal, {
        userId: attackerId,
        weekPlanId,
      }),
    ).rejects.toThrow("Week plan access denied");
  });
});
