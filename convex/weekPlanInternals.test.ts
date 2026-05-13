/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

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
      status: "draft",
      source: "ai",
      createdAt: Date.now(),
    }),
  );
}

describe("linkWorkoutPlanToDayInternal", () => {
  test("links a workout plan to a day and returns the weekPlanId", async () => {
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
    const plan = await t.run(async (ctx) => ctx.db.get(weekPlanId));
    expect(plan?.days[0].workoutPlanId).toBe(workoutPlanId);
  });

  test("returns null when the week plan no longer exists (concurrent deletion race)", async () => {
    // Fixes TONALCOACH-12: instead of throwing "Week plan not found or access denied"
    // (which Convex would report to Sentry), return null so callers can handle it
    // gracefully without generating noise.
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, userId);
    const workoutPlanId = await seedWorkoutPlan(t, userId);

    // Delete the week plan to simulate the race condition
    await t.run(async (ctx) => ctx.db.delete(weekPlanId));

    const result = await t.mutation(internal.weekPlanInternals.linkWorkoutPlanToDayInternal, {
      userId,
      weekPlanId,
      dayIndex: 0,
      workoutPlanId,
    });

    expect(result).toBeNull();
  });

  test("throws access denied when week plan belongs to a different user", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const attackerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, ownerId);
    const workoutPlanId = await seedWorkoutPlan(t, attackerId);

    await expect(
      t.mutation(internal.weekPlanInternals.linkWorkoutPlanToDayInternal, {
        userId: attackerId,
        weekPlanId,
        dayIndex: 0,
        workoutPlanId,
      }),
    ).rejects.toThrow("Week plan access denied");
  });

  test("throws when dayIndex is out of range", async () => {
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
