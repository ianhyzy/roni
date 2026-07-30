/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";
import { SCHEDULING_RECEIPT_FRESH_MS } from "./schedulingReceipts";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../tonal/${key.slice(2)}` : key] = value;
}
const WORKOUT_ID = "workout-1";
const SCHEDULED_DATE = "2026-07-30";

async function seedTarget(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const workoutPlanId = await ctx.db.insert("workoutPlans", {
      userId,
      tonalWorkoutId: WORKOUT_ID,
      title: "Push Day",
      blocks: [],
      status: "pushed",
      createdAt: 1,
    });
    return { userId, workoutPlanId, workoutId: WORKOUT_ID, scheduledDate: SCHEDULED_DATE };
  });
}

describe("Tonal scheduling receipts", () => {
  it("trusts only a fresh receipt completed by the matching claim", async () => {
    const t = convexTest(schema, modules);
    const target = await seedTarget(t);
    const verifiedAt = 1_000_000;

    await t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
      ...target,
      claimId: "claim-1",
      now: verifiedAt,
    });
    await t.mutation(internal.tonal.schedulingReceipts.completeClaim, {
      ...target,
      claimId: "claim-1",
      workoutSignupId: " signup-1 ",
      verifiedAt,
    });

    const plan = await t.run((ctx) => ctx.db.get(target.workoutPlanId));
    expect(plan).toMatchObject({
      tonalWorkoutSignupId: "signup-1",
      tonalScheduledDate: SCHEDULED_DATE,
      tonalSchedulingReceiptVerifiedAt: verifiedAt,
    });
    expect(plan?.tonalSchedulingClaim).toBeUndefined();

    await expect(
      t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
        ...target,
        claimId: "claim-2",
        now: verifiedAt + SCHEDULING_RECEIPT_FRESH_MS,
      }),
    ).resolves.toEqual({ status: "already_scheduled", workoutSignupId: "signup-1" });
    await expect(
      t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
        ...target,
        claimId: "claim-3",
        now: verifiedAt + SCHEDULING_RECEIPT_FRESH_MS + 1,
      }),
    ).resolves.toEqual({ status: "acquired", phase: "checking" });
  });

  it("treats legacy receipts without a verification timestamp as stale", async () => {
    const t = convexTest(schema, modules);
    const target = await seedTarget(t);
    await t.run((ctx) =>
      ctx.db.patch(target.workoutPlanId, {
        tonalWorkoutSignupId: "legacy-signup",
        tonalScheduledDate: SCHEDULED_DATE,
      }),
    );

    await expect(
      t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
        ...target,
        claimId: "claim-1",
        now: 1_000_000,
      }),
    ).resolves.toEqual({ status: "acquired", phase: "checking" });
  });

  it("rejects a different owner or Tonal workout before changing the plan", async () => {
    const t = convexTest(schema, modules);
    const target = await seedTarget(t);
    const otherUserId = await t.run((ctx) => ctx.db.insert("users", {}));

    await expect(
      t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
        ...target,
        userId: otherUserId,
        claimId: "claim-1",
        now: 1,
      }),
    ).rejects.toThrow("Workout plan not owned by user");
    await expect(
      t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
        ...target,
        workoutId: "other-workout",
        claimId: "claim-1",
        now: 1,
      }),
    ).rejects.toThrow("Workout plan does not match Tonal workout");

    const plan = await t.run((ctx) => ctx.db.get(target.workoutPlanId));
    expect(plan?.tonalSchedulingClaim).toBeUndefined();
  });

  it("requires the exact claim owner to complete a receipt", async () => {
    const t = convexTest(schema, modules);
    const target = await seedTarget(t);
    await t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
      ...target,
      claimId: "claim-1",
      now: 1,
    });

    await expect(
      t.mutation(internal.tonal.schedulingReceipts.completeClaim, {
        ...target,
        claimId: "claim-2",
        workoutSignupId: "signup-1",
        verifiedAt: 2,
      }),
    ).rejects.toThrow("claim is no longer owned");
  });
});
