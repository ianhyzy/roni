/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? "../coach/" + key.slice(2) : key] = value;
}

type WorkoutStatus = Doc<"workoutPlans">["status"];
type SchedulingGuard = "receipt" | "claim";

async function seedWorkoutPlan(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  status: WorkoutStatus,
  guard?: SchedulingGuard,
): Promise<Id<"workoutPlans">> {
  return t.run((ctx) =>
    ctx.db.insert("workoutPlans", {
      userId,
      title: `${status} workout`,
      blocks: [{ exercises: [{ movementId: "movement-1", sets: 3, reps: 8 }] }],
      status,
      ...(status === "pushed" ? { tonalWorkoutId: "tonal-workout-1" } : {}),
      ...(guard === "receipt"
        ? {
            tonalWorkoutSignupId: "signup-1",
            tonalScheduledDate: "2099-08-03",
            tonalSchedulingReceiptVerifiedAt: 1,
          }
        : {}),
      ...(guard === "claim"
        ? {
            tonalSchedulingClaim: {
              claimId: "claim-1",
              workoutId: "tonal-workout-1",
              scheduledDate: "2099-08-03",
              phase: "checking" as const,
              leaseExpiresAt: 10_000,
            },
          }
        : {}),
      createdAt: Date.now(),
    }),
  );
}

async function seedWeekPlan(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  fromWorkoutPlanId: Id<"workoutPlans">,
  toWorkoutPlanId?: Id<"workoutPlans">,
): Promise<Id<"weekPlans">> {
  return t.run((ctx) =>
    ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: "2099-08-03",
      preferredSplit: "ppl",
      targetDays: 2,
      days: [
        { sessionType: "push", status: "programmed", workoutPlanId: fromWorkoutPlanId },
        toWorkoutPlanId
          ? { sessionType: "pull", status: "programmed", workoutPlanId: toWorkoutPlanId }
          : { sessionType: "rest", status: "programmed" },
        ...Array.from({ length: 5 }, () => ({
          sessionType: "rest" as const,
          status: "programmed" as const,
        })),
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("swapDaySlots", () => {
  it("swaps days when every linked workout is still a draft", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const fromWorkoutPlanId = await seedWorkoutPlan(t, userId, "draft");
    const toWorkoutPlanId = await seedWorkoutPlan(t, userId, "draft");
    const weekPlanId = await seedWeekPlan(t, userId, fromWorkoutPlanId, toWorkoutPlanId);

    const result = await t.mutation(internal.coach.weekDayModifications.swapDaySlots, {
      userId,
      weekPlanId,
      fromDayIndex: 0,
      toDayIndex: 1,
    });

    expect(result).toEqual({ ok: true });
    const plan = await t.run((ctx) => ctx.db.get(weekPlanId));
    expect(plan?.days[0].workoutPlanId).toBe(toWorkoutPlanId);
    expect(plan?.days[1].workoutPlanId).toBe(fromWorkoutPlanId);
  });

  it.each([
    { label: "source", fromStatus: "pushed" as const, toStatus: "draft" as const },
    { label: "destination", fromStatus: "draft" as const, toStatus: "completed" as const },
  ])("rejects a non-draft $label workout without changing the week", async (options) => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const fromWorkoutPlanId = await seedWorkoutPlan(t, userId, options.fromStatus);
    const toWorkoutPlanId = await seedWorkoutPlan(t, userId, options.toStatus);
    const weekPlanId = await seedWeekPlan(t, userId, fromWorkoutPlanId, toWorkoutPlanId);
    const before = await t.run((ctx) => ctx.db.get(weekPlanId));

    const result = await t.mutation(internal.coach.weekDayModifications.swapDaySlots, {
      userId,
      weekPlanId,
      fromDayIndex: 0,
      toDayIndex: 1,
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Only draft workouts can be moved. Pushed or completed workouts stay on their Tonal Calendar date.",
    });
    const after = await t.run((ctx) => ctx.db.get(weekPlanId));
    expect(after?.days).toEqual(before?.days);
  });

  it.each([
    { label: "source receipt", fromGuard: "receipt" as const, toGuard: undefined },
    { label: "destination claim", fromGuard: undefined, toGuard: "claim" as const },
  ])("rejects a draft with a $label without changing the week", async (options) => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const fromWorkoutPlanId = await seedWorkoutPlan(t, userId, "draft", options.fromGuard);
    const toWorkoutPlanId = await seedWorkoutPlan(t, userId, "draft", options.toGuard);
    const weekPlanId = await seedWeekPlan(t, userId, fromWorkoutPlanId, toWorkoutPlanId);
    const before = await t.run((ctx) => ctx.db.get(weekPlanId));

    const result = await t.mutation(internal.coach.weekDayModifications.swapDaySlots, {
      userId,
      weekPlanId,
      fromDayIndex: 0,
      toDayIndex: 1,
    });

    expect(result).toEqual({
      ok: false,
      error:
        "Only draft workouts can be moved. Pushed or completed workouts stay on their Tonal Calendar date.",
    });
    const after = await t.run((ctx) => ctx.db.get(weekPlanId));
    expect(after?.days).toEqual(before?.days);
  });

  it("rejects a linked workout owned by another user", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const otherUserId = await t.run((ctx) => ctx.db.insert("users", {}));
    const fromWorkoutPlanId = await seedWorkoutPlan(t, userId, "draft");
    const toWorkoutPlanId = await seedWorkoutPlan(t, otherUserId, "draft");
    const weekPlanId = await seedWeekPlan(t, userId, fromWorkoutPlanId, toWorkoutPlanId);

    const result = await t.mutation(internal.coach.weekDayModifications.swapDaySlots, {
      userId,
      weekPlanId,
      fromDayIndex: 0,
      toDayIndex: 1,
    });

    expect(result).toEqual({ ok: false, error: "Linked workout not found or access denied" });
  });

  it("rejects a missing linked workout", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const fromWorkoutPlanId = await seedWorkoutPlan(t, userId, "draft");
    const missingWorkoutPlanId = await seedWorkoutPlan(t, userId, "draft");
    const weekPlanId = await seedWeekPlan(t, userId, fromWorkoutPlanId, missingWorkoutPlanId);
    await t.run((ctx) => ctx.db.delete(missingWorkoutPlanId));

    const result = await t.mutation(internal.coach.weekDayModifications.swapDaySlots, {
      userId,
      weekPlanId,
      fromDayIndex: 0,
      toDayIndex: 1,
    });

    expect(result).toEqual({ ok: false, error: "Linked workout not found or access denied" });
  });
});
