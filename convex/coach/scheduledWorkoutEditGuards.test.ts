/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? "../coach/" + key.slice(2) : key] = value;
}

type WorkoutGuardFixture = "pushed" | "receipt" | "claim";

async function seedScheduledWorkout(
  t: ReturnType<typeof convexTest>,
  guard: WorkoutGuardFixture = "pushed",
) {
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  const workoutPlanId = await t.run((ctx) =>
    ctx.db.insert("workoutPlans", {
      userId,
      title: "Scheduled workout",
      blocks: [{ exercises: [{ movementId: "movement-1", sets: 3, reps: 8 }] }],
      status: guard === "pushed" ? ("pushed" as const) : ("draft" as const),
      ...(guard === "pushed"
        ? {
            tonalWorkoutId: "tonal-workout-1",
            tonalWorkoutSignupId: "signup-1",
            tonalScheduledDate: "2099-08-03",
          }
        : {}),
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
  const weekPlanId = await t.run((ctx) =>
    ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: "2099-08-03",
      preferredSplit: "ppl",
      targetDays: 1,
      days: [
        { sessionType: "push", status: "programmed", workoutPlanId },
        ...Array.from({ length: 6 }, () => ({
          sessionType: "rest" as const,
          status: "programmed" as const,
        })),
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  return { userId, workoutPlanId, weekPlanId };
}

const EDIT_ERROR =
  "Only draft workouts can be edited. Pushed or completed workouts stay on their Tonal Calendar date.";

describe("scheduled workout edit guards", () => {
  it("rejects adjusting the duration of a scheduled workout", async () => {
    const t = convexTest(schema, modules);
    const { userId, workoutPlanId, weekPlanId } = await seedScheduledWorkout(t);

    const result = await t.action(internal.coach.weekModifications.adjustDayDuration, {
      userId,
      weekPlanId,
      dayIndex: 0,
      newDurationMinutes: 45,
    });

    expect(result).toEqual({ ok: false, error: EDIT_ERROR });
    const plan = await t.run((ctx) => ctx.db.get(weekPlanId));
    expect(plan?.days[0].workoutPlanId).toBe(workoutPlanId);
  });

  it("rejects rebuilding a scheduled workout", async () => {
    const t = convexTest(schema, modules);
    const { userId, workoutPlanId, weekPlanId } = await seedScheduledWorkout(t);

    const result = await t.action(internal.coach.rebuildDay.rebuildDay, {
      userId,
      weekPlanId,
      dayIndex: 0,
      blocks: [{ exercises: [{ movementId: "movement-2", sets: 3, reps: 10 }] }],
    });

    expect(result).toEqual({ ok: false, error: EDIT_ERROR });
    const plan = await t.run((ctx) => ctx.db.get(weekPlanId));
    expect(plan?.days[0].workoutPlanId).toBe(workoutPlanId);
  });

  it.each(["receipt", "claim"] as const)(
    "rejects replacing a draft workout with a scheduling %s",
    async (guard) => {
      const t = convexTest(schema, modules);
      const { userId, workoutPlanId, weekPlanId } = await seedScheduledWorkout(t, guard);

      const result = await t.mutation(internal.weekPlanInternals.replaceDayDraftWorkoutInternal, {
        userId,
        weekPlanId,
        dayIndex: 0,
        expectedWorkoutPlanId: workoutPlanId,
        title: "Replacement workout",
        blocks: [{ exercises: [{ movementId: "movement-2", sets: 3, reps: 10 }] }],
      });

      expect(result).toEqual({ ok: false, error: EDIT_ERROR });
      const plan = await t.run((ctx) => ctx.db.get(weekPlanId));
      expect(plan?.days[0].workoutPlanId).toBe(workoutPlanId);
      const workouts = await t.run((ctx) => ctx.db.query("workoutPlans").collect());
      expect(workouts.map((workout) => workout._id)).toEqual([workoutPlanId]);
    },
  );
});
