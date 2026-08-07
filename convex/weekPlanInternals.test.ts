/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { getWorkoutApprovalFingerprint } from "./weekPlanHelpers";

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

describe("deleteWeekPlanInternal", () => {
  test("deletes a week plan and all unique linked drafts", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, userId);
    const workoutPlanId = await t.run((ctx) =>
      ctx.db.insert("workoutPlans", {
        userId,
        title: "Draft",
        blocks: [],
        status: "draft",
        createdAt: 1,
      }),
    );
    await t.run(async (ctx) => {
      const plan = await ctx.db.get(weekPlanId);
      if (!plan) throw new Error("Missing fixture week plan");
      const days = [...plan.days];
      days[0] = { ...days[0], workoutPlanId };
      days[1] = { ...days[1], workoutPlanId };
      await ctx.db.patch(weekPlanId, { days });
    });

    await expect(
      t.mutation(internal.weekPlanDeletion.deleteWeekPlanInternal, { userId, weekPlanId }),
    ).resolves.toEqual({ ok: true, deleted: true });

    await expect(t.run((ctx) => ctx.db.get(weekPlanId))).resolves.toBeNull();
    await expect(t.run((ctx) => ctx.db.get(workoutPlanId))).resolves.toBeNull();
  });

  test("returns a safe no-op when the plan is already gone", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, userId);

    await t.mutation(internal.weekPlanDeletion.deleteWeekPlanInternal, { userId, weekPlanId });
    await expect(
      t.mutation(internal.weekPlanDeletion.deleteWeekPlanInternal, { userId, weekPlanId }),
    ).resolves.toEqual({ ok: true, deleted: false });
  });

  test("returns a structured ownership failure without deleting the week", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const attackerId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, ownerId);

    await expect(
      t.mutation(internal.weekPlanDeletion.deleteWeekPlanInternal, {
        userId: attackerId,
        weekPlanId,
      }),
    ).resolves.toEqual({ ok: false, error: "Week plan access denied" });
    await expect(t.run((ctx) => ctx.db.get(weekPlanId))).resolves.not.toBeNull();
  });

  test.each([
    {
      name: "pushed",
      workout: { status: "pushed" as const, tonalWorkoutId: "tonal-1" },
      error: "Only draft week plans can be deleted",
    },
    {
      name: "completed",
      workout: { status: "completed" as const, tonalWorkoutId: "tonal-1" },
      error: "Only draft week plans can be deleted",
    },
    {
      name: "scheduled",
      workout: {
        status: "draft" as const,
        tonalWorkoutSignupId: "signup-1",
        tonalScheduledDate: "2026-04-20",
        tonalSchedulingReceiptVerifiedAt: 1,
      },
      error: "Scheduled workouts cannot be deleted",
    },
    {
      name: "claimed",
      workout: {
        status: "draft" as const,
        tonalSchedulingClaim: {
          claimId: "claim-1",
          workoutId: "tonal-1",
          scheduledDate: "2026-04-20",
          phase: "checking" as const,
          leaseExpiresAt: 10_000,
        },
      },
      error: "Workout scheduling is in progress",
    },
  ])("rejects a $name workout without deleting any linked row", async ({ workout, error }) => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, userId);
    const [safeDraftId, guardedWorkoutId] = await t.run(async (ctx) => {
      const safeDraftId = await ctx.db.insert("workoutPlans", {
        userId,
        title: "Safe draft",
        blocks: [],
        status: "draft",
        createdAt: 1,
      });
      const guardedWorkoutId = await ctx.db.insert("workoutPlans", {
        userId,
        title: "Guarded",
        blocks: [],
        createdAt: 2,
        ...workout,
      });
      const plan = await ctx.db.get(weekPlanId);
      if (!plan) throw new Error("Missing fixture week plan");
      const days = [...plan.days];
      days[0] = { ...days[0], workoutPlanId: safeDraftId };
      days[1] = { ...days[1], workoutPlanId: guardedWorkoutId };
      await ctx.db.patch(weekPlanId, { days });
      return [safeDraftId, guardedWorkoutId] as const;
    });

    await expect(
      t.mutation(internal.weekPlanDeletion.deleteWeekPlanInternal, { userId, weekPlanId }),
    ).resolves.toEqual({ ok: false, error });
    const rows = await t.run(async (ctx) =>
      Promise.all([ctx.db.get(weekPlanId), ctx.db.get(safeDraftId), ctx.db.get(guardedWorkoutId)]),
    );
    expect(rows.every(Boolean)).toBe(true);
  });

  test("rejects a missing linked workout without deleting the week", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, userId);
    const missingWorkoutPlanId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workoutPlans", {
        userId,
        title: "Temporary",
        blocks: [],
        status: "draft",
        createdAt: 1,
      });
      const plan = await ctx.db.get(weekPlanId);
      if (!plan) throw new Error("Missing fixture week plan");
      const days = [...plan.days];
      days[0] = { ...days[0], workoutPlanId: id };
      await ctx.db.patch(weekPlanId, { days });
      await ctx.db.delete(id);
      return id;
    });

    await expect(
      t.mutation(internal.weekPlanDeletion.deleteWeekPlanInternal, { userId, weekPlanId }),
    ).resolves.toEqual({ ok: false, error: "Linked workout not found" });
    await expect(t.run((ctx) => ctx.db.get(weekPlanId))).resolves.not.toBeNull();
    await expect(t.run((ctx) => ctx.db.get(missingWorkoutPlanId))).resolves.toBeNull();
  });

  test("rejects a linked workout owned by another user without deleting either row", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const otherUserId = await t.run((ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, userId);
    const workoutPlanId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workoutPlans", {
        userId: otherUserId,
        title: "Other user's draft",
        blocks: [],
        status: "draft",
        createdAt: 1,
      });
      const plan = await ctx.db.get(weekPlanId);
      if (!plan) throw new Error("Missing fixture week plan");
      const days = [...plan.days];
      days[0] = { ...days[0], workoutPlanId: id };
      await ctx.db.patch(weekPlanId, { days });
      return id;
    });

    await expect(
      t.mutation(internal.weekPlanDeletion.deleteWeekPlanInternal, { userId, weekPlanId }),
    ).resolves.toEqual({ ok: false, error: "Linked workout access denied" });
    await expect(t.run((ctx) => ctx.db.get(weekPlanId))).resolves.not.toBeNull();
    await expect(t.run((ctx) => ctx.db.get(workoutPlanId))).resolves.not.toBeNull();
  });
});

describe("replaceDayDraftWorkoutInternal", () => {
  test("rejects a pushed workout without changing the linked day", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const oldWorkoutPlanId = await t.run((ctx) =>
      ctx.db.insert("workoutPlans", {
        userId,
        title: "Already pushed",
        blocks: [{ exercises: [{ movementId: "movement-1", sets: 3, reps: 8 }] }],
        status: "pushed",
        tonalWorkoutId: "tonal-workout-1",
        tonalWorkoutSignupId: "signup-1",
        tonalScheduledDate: "2026-04-20",
        createdAt: Date.now(),
      }),
    );
    const weekPlanId = await seedWeekPlan(t, userId);
    await t.run(async (ctx) => {
      const plan = await ctx.db.get(weekPlanId);
      if (!plan) throw new Error("Missing fixture week plan");
      const days = [...plan.days];
      days[0] = {
        sessionType: "push",
        status: "programmed",
        workoutPlanId: oldWorkoutPlanId,
      };
      await ctx.db.patch(weekPlanId, { days });
    });

    const result = await t.mutation(internal.weekPlanInternals.replaceDayDraftWorkoutInternal, {
      userId,
      weekPlanId,
      dayIndex: 0,
      expectedWorkoutPlanId: oldWorkoutPlanId,
      title: "Replacement",
      blocks: [{ exercises: [{ movementId: "movement-2", sets: 3, reps: 10 }] }],
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Only draft workouts can be edited. Pushed or completed workouts stay on their Tonal Calendar date.",
    });
    const plan = await t.run((ctx) => ctx.db.get(weekPlanId));
    expect(plan?.days[0].workoutPlanId).toBe(oldWorkoutPlanId);
    const workoutPlans = await t.run((ctx) => ctx.db.query("workoutPlans").collect());
    expect(workoutPlans).toHaveLength(1);
  });

  test("rejects when the linked workout changes before replacement", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const [expectedWorkoutPlanId, currentWorkoutPlanId] = await t.run(async (ctx) => {
      const createDraft = (title: string) =>
        ctx.db.insert("workoutPlans", {
          userId,
          title,
          blocks: [{ exercises: [{ movementId: "movement-1", sets: 3, reps: 8 }] }],
          status: "draft" as const,
          createdAt: Date.now(),
        });
      return await Promise.all([createDraft("Expected"), createDraft("Current")]);
    });
    const weekPlanId = await seedWeekPlan(t, userId);
    await t.run(async (ctx) => {
      const plan = await ctx.db.get(weekPlanId);
      if (!plan) throw new Error("Missing fixture week plan");
      const days = [...plan.days];
      days[0] = {
        sessionType: "push",
        status: "programmed",
        workoutPlanId: currentWorkoutPlanId,
      };
      await ctx.db.patch(weekPlanId, { days });
    });

    const result = await t.mutation(internal.weekPlanInternals.replaceDayDraftWorkoutInternal, {
      userId,
      weekPlanId,
      dayIndex: 0,
      expectedWorkoutPlanId,
      title: "Replacement",
      blocks: [{ exercises: [{ movementId: "movement-2", sets: 3, reps: 10 }] }],
    });

    expect(result).toEqual({
      ok: false,
      error: "This workout changed while the edit was being prepared. Please retry.",
    });
    const plan = await t.run((ctx) => ctx.db.get(weekPlanId));
    expect(plan?.days[0].workoutPlanId).toBe(currentWorkoutPlanId);
    const workoutPlans = await t.run((ctx) => ctx.db.query("workoutPlans").collect());
    expect(workoutPlans.map((workoutPlan) => workoutPlan._id).sort()).toEqual(
      [expectedWorkoutPlanId, currentWorkoutPlanId].sort(),
    );
  });
});

describe("replaceDraftWithPushed", () => {
  test("keeps the first pushed plan canonical when two replacements race", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const otherUserId = await t.run((ctx) => ctx.db.insert("users", {}));
    const weekPlanId = await seedWeekPlan(t, userId);
    const [draftId, winnerId, loserId] = await t.run(async (ctx) => {
      const draftId = await ctx.db.insert("workoutPlans", {
        userId,
        title: "Draft",
        blocks: [],
        status: "draft",
        createdAt: 1,
      });
      const createPushed = (title: string, tonalWorkoutId: string) =>
        ctx.db.insert("workoutPlans", {
          userId,
          title,
          blocks: [],
          status: "pushed" as const,
          tonalWorkoutId,
          createdAt: 2,
        });
      const winnerId = await createPushed("Winner", "tonal-winner");
      const loserId = await createPushed("Loser", "tonal-loser");
      const plan = await ctx.db.get(weekPlanId);
      if (!plan) throw new Error("Missing fixture week plan");
      const days = [...plan.days];
      days[0] = { sessionType: "push", status: "programmed", workoutPlanId: draftId };
      await ctx.db.patch(weekPlanId, { days });
      return [draftId, winnerId, loserId] as const;
    });
    const approvedFingerprint = getWorkoutApprovalFingerprint({ title: "Draft", blocks: [] });
    const replace = (
      replacementId: Id<"workoutPlans">,
      ownerId = userId,
      expectedDraftFingerprint = approvedFingerprint,
    ) =>
      t.mutation(internal.weekPlanInternals.replaceDraftWithPushed, {
        userId: ownerId,
        weekPlanId,
        dayIndex: 0,
        oldWorkoutPlanId: draftId,
        expectedDraftFingerprint,
        newWorkoutPlanId: replacementId,
      });

    await expect(replace(winnerId)).resolves.toEqual({
      status: "replaced",
      workoutPlanId: winnerId,
    });
    await expect(replace(loserId, userId, "deliberately-stale-fingerprint")).resolves.toEqual({
      status: "canonical",
      workoutPlanId: winnerId,
    });
    await expect(replace(loserId, otherUserId)).resolves.toEqual({
      status: "conflict",
      error: "Week plan not found or access denied",
    });
    const [plan, draft, loser] = await t.run((ctx) =>
      Promise.all([ctx.db.get(weekPlanId), ctx.db.get(draftId), ctx.db.get(loserId)]),
    );
    expect(plan?.days[0].workoutPlanId).toBe(winnerId);
    expect(draft).toBeNull();
    expect(loser).not.toBeNull();
  });
});
