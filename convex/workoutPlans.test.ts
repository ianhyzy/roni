/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { type FunctionReference, getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getRetryPushCompletion, SCHEDULED_WORKOUT_DELETE_ERROR } from "./workoutPlans";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

async function seedPlan(
  t: ReturnType<typeof convexTest>,
  status: Doc<"workoutPlans">["status"],
): Promise<Id<"workoutPlans">> {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  return insertPlan(t, { userId, status, movementId: "seed-movement" });
}

async function insertPlan(
  t: ReturnType<typeof convexTest>,
  {
    userId,
    status,
    movementId,
  }: {
    userId: Id<"users">;
    status: Doc<"workoutPlans">["status"];
    movementId: string;
  },
): Promise<Id<"workoutPlans">> {
  return t.mutation(internal.workoutPlans.create, {
    userId,
    title: movementId,
    blocks: [{ exercises: [{ movementId, sets: 3 }] }],
    status,
    createdAt: Date.now(),
  });
}

describe("transitionToPushing — atomic claim for retry", () => {
  test("claims a failed plan exactly once", async () => {
    const t = convexTest(schema, modules);
    const planId = await seedPlan(t, "failed");

    const first = await t.mutation(internal.workoutPlans.transitionToPushing, { planId });
    const second = await t.mutation(internal.workoutPlans.transitionToPushing, { planId });

    expect(first).toBe(true);
    expect(second).toBe(false);
    const plan = await t.run(async (ctx) => ctx.db.get(planId));
    expect(plan?.status).toBe("pushing");
  });

  test("claims a draft plan", async () => {
    const t = convexTest(schema, modules);
    const planId = await seedPlan(t, "draft");

    const claimed = await t.mutation(internal.workoutPlans.transitionToPushing, { planId });

    expect(claimed).toBe(true);
  });

  test("refuses to claim a pushed plan", async () => {
    const t = convexTest(schema, modules);
    const planId = await seedPlan(t, "pushed");

    const claimed = await t.mutation(internal.workoutPlans.transitionToPushing, { planId });

    expect(claimed).toBe(false);
  });

  test("refuses to claim a pushing plan (prevents double-retry)", async () => {
    const t = convexTest(schema, modules);
    const planId = await seedPlan(t, "pushing");

    const claimed = await t.mutation(internal.workoutPlans.transitionToPushing, { planId });

    expect(claimed).toBe(false);
  });
});

describe("getRetryPushCompletion", () => {
  test("treats structured workflow push failures as failed completions", () => {
    const completion = getRetryPushCompletion({
      kind: "success",
      returnValue: { status: "failed", error: "Tonal API 500" },
    });

    expect(completion).toEqual({ status: "failed", reason: "Tonal API 500" });
  });

  test("treats successful workflow pushes as pushed completions", () => {
    const completion = getRetryPushCompletion({
      kind: "success",
      returnValue: { status: "pushed", workoutId: "tonal-123" },
    });

    expect(completion).toEqual({ status: "pushed" });
  });

  test("keeps failed workpool results as failed completions", () => {
    const completion = getRetryPushCompletion({ kind: "failed", error: "workflow crashed" });

    expect(completion).toEqual({ status: "failed", reason: "workflow crashed" });
  });
});

describe("getRecentMovementIds", () => {
  test("keeps the 50 most recent movement IDs across completed and pushed plans", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    for (let i = 1; i <= 26; i++) {
      await insertPlan(t, {
        userId,
        status: "completed",
        movementId: `completed-${i}`,
      });
    }

    for (let i = 1; i <= 26; i++) {
      await insertPlan(t, {
        userId,
        status: "pushed",
        movementId: `pushed-${i}`,
      });
    }

    const recentMovementIds = await t.query(internal.workoutPlans.getRecentMovementIds, { userId });

    expect(recentMovementIds).toHaveLength(50);
    expect(recentMovementIds).not.toContain("completed-1");
    expect(recentMovementIds).not.toContain("completed-2");
    expect(recentMovementIds).toContain("pushed-1");
    expect(recentMovementIds).toContain("pushed-2");
  });
});

describe("getDeleteWorkoutBlocker", () => {
  async function seedDeletionPlan(
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
    overrides: Partial<Doc<"workoutPlans">> = {},
  ) {
    return await t.run((ctx) =>
      ctx.db.insert("workoutPlans", {
        userId,
        tonalWorkoutId: "tonal-delete-1",
        title: "Standalone workout",
        blocks: [],
        status: "pushed",
        createdAt: 1,
        ...overrides,
      }),
    );
  }

  test("blocks an owned workout linked to any weekly plan", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const workoutPlanId = await seedDeletionPlan(t, userId);
    await t.run(async (ctx) => {
      for (let index = 0; index < 16; index += 1) {
        await ctx.db.insert("weekPlans", {
          userId,
          weekStartDate: `2026-07-${String(index + 1).padStart(2, "0")}`,
          preferredSplit: "ppl",
          targetDays: 0,
          days: [],
          createdAt: index,
          updatedAt: index,
        });
      }
      await ctx.db.insert("weekPlans", {
        userId,
        weekStartDate: "2026-08-01",
        preferredSplit: "ppl",
        targetDays: 1,
        days: [
          {
            sessionType: "push",
            status: "programmed",
            workoutPlanId,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      });
    });

    await expect(
      t.action(internal.workoutPlans.getDeleteWorkoutBlocker, {
        userId,
        tonalWorkoutId: "tonal-delete-1",
      }),
    ).resolves.toBe(SCHEDULED_WORKOUT_DELETE_ERROR);
  });

  test.each([
    { name: "signup receipt", evidence: { tonalWorkoutSignupId: "signup-1" } },
    { name: "scheduled date", evidence: { tonalScheduledDate: "2026-07-27" } },
    {
      name: "verified receipt",
      evidence: { tonalSchedulingReceiptVerifiedAt: 1 },
    },
  ])("blocks persisted $name evidence", async ({ evidence }) => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    await seedDeletionPlan(t, userId, evidence);

    await expect(
      t.action(internal.workoutPlans.getDeleteWorkoutBlocker, {
        userId,
        tonalWorkoutId: "tonal-delete-1",
      }),
    ).resolves.toBe(SCHEDULED_WORKOUT_DELETE_ERROR);
  });

  test.each([
    ["active", 1, SCHEDULED_WORKOUT_DELETE_ERROR],
    ["expired", -1, null],
    ["equal-boundary", 0, null],
  ])(
    "returns the expected deletion blocker for an $name claim",
    async (name, leaseOffset, expected) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
      try {
        const t = convexTest(schema, modules);
        const userId = await t.run((ctx) => ctx.db.insert("users", {}));
        await seedDeletionPlan(t, userId, {
          tonalSchedulingClaim: {
            claimId: "claim-1",
            workoutId: "tonal-delete-1",
            scheduledDate: "2026-07-27",
            phase: "checking",
            leaseExpiresAt: Date.now() + leaseOffset,
          },
        });

        await expect(
          t.action(internal.workoutPlans.getDeleteWorkoutBlocker, {
            userId,
            tonalWorkoutId: "tonal-delete-1",
          }),
        ).resolves.toBe(expected);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  test("allows a standalone workout but fails closed beyond the week scan ceiling", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    await seedDeletionPlan(t, userId);

    await expect(
      t.action(internal.workoutPlans.getDeleteWorkoutBlocker, {
        userId,
        tonalWorkoutId: "tonal-delete-1",
      }),
    ).resolves.toBeNull();

    await t.run(async (ctx) => {
      for (let index = 0; index < 1_601; index += 1) {
        await ctx.db.insert("weekPlans", {
          userId,
          weekStartDate: "2026-08-01",
          preferredSplit: "ppl",
          targetDays: 0,
          days: [],
          createdAt: index,
          updatedAt: index,
        });
      }
    });

    await expect(
      t.action(internal.workoutPlans.getDeleteWorkoutBlocker, {
        userId,
        tonalWorkoutId: "tonal-delete-1",
      }),
    ).resolves.toBe(SCHEDULED_WORKOUT_DELETE_ERROR);
  });

  test("allows absent and other-user records", async () => {
    const t = convexTest(schema, modules);
    const [userId, otherUserId] = await t.run(async (ctx) => [
      await ctx.db.insert("users", {}),
      await ctx.db.insert("users", {}),
    ]);
    await seedDeletionPlan(t, otherUserId, { tonalWorkoutSignupId: "signup-other" });

    await expect(
      t.action(internal.workoutPlans.getDeleteWorkoutBlocker, {
        userId,
        tonalWorkoutId: "tonal-delete-1",
      }),
    ).resolves.toBeNull();
    await expect(
      t.action(internal.workoutPlans.getDeleteWorkoutBlocker, {
        userId,
        tonalWorkoutId: "missing-tonal-id",
      }),
    ).resolves.toBeNull();
  });
});

test("retry push workflow keeps a successful push when cache eviction fails", async () => {
  type TestFunctionReference = FunctionReference<
    "query" | "mutation" | "action",
    "public" | "internal"
  >;
  type RetryPushHandler = (
    step: {
      runAction: (ref: unknown, args: Record<string, unknown>) => Promise<{ id: string }>;
      runMutation: (ref: unknown, args: Record<string, unknown>) => Promise<void>;
    },
    args: {
      planId: Id<"workoutPlans">;
      userId: Id<"users">;
      title: string;
      blocks: Array<{ exercises: Array<{ movementId: string; sets: number }> }>;
    },
  ) => Promise<{ status: "pushed"; workoutId: string }>;

  vi.resetModules();
  vi.doMock("./workflows", () => ({
    workflow: {
      define: (definition: { handler: unknown }) => ({ _handler: definition.handler }),
      start: vi.fn(),
    },
  }));
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-28T12:00:00Z"));

  try {
    const { retryPushWorkflow } = await import("./workoutPlans");
    const handler = (retryPushWorkflow as unknown as { _handler: RetryPushHandler })._handler;
    const runAction = vi.fn(async (_ref: unknown, _args: Record<string, unknown>) => ({
      id: "tonal-workout",
    }));
    const runMutation = vi.fn(async (_ref: unknown, _args: Record<string, unknown>) => undefined);
    const planId = "plan-id" as Id<"workoutPlans">;
    const userId = "user-id" as Id<"users">;

    const result = await handler(
      { runAction, runMutation },
      {
        planId,
        userId,
        title: "Push Day",
        blocks: [{ exercises: [{ movementId: "movement-id", sets: 3 }] }],
      },
    );

    expect(result).toEqual({ status: "pushed", workoutId: "tonal-workout" });
    expect(
      runMutation.mock.calls.map(([ref]) => getFunctionName(ref as TestFunctionReference)),
    ).toEqual(["workoutPlans:updatePushOutcome", "tonal/cache:deleteCacheEntryByType"]);
    expect(runMutation.mock.calls[1]?.[1]).toEqual({
      userId,
      dataType: "customWorkouts",
    });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingRunMutation = vi.fn(
      async (ref: unknown, _args: Record<string, unknown>): Promise<void> => {
        if (
          getFunctionName(ref as TestFunctionReference) === "tonal/cache:deleteCacheEntryByType"
        ) {
          throw new Error("Cache unavailable");
        }
      },
    );

    const resultWithCacheFailure = await handler(
      { runAction, runMutation: failingRunMutation },
      {
        planId,
        userId,
        title: "Push Day",
        blocks: [{ exercises: [{ movementId: "movement-id", sets: 3 }] }],
      },
    );

    expect(resultWithCacheFailure).toEqual({ status: "pushed", workoutId: "tonal-workout" });
    expect(consoleError).toHaveBeenCalledWith(
      "[retryPushWorkflow] Custom workout cache eviction failed",
      expect.objectContaining({ message: "Cache unavailable" }),
    );
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock("./workflows");
    vi.resetModules();
  }
});
