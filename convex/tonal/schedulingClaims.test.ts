/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { type FunctionReference, getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import schema from "../schema";
import { scheduleWorkout, type ScheduleWorkoutResult } from "./scheduling";
import { SCHEDULING_CLAIM_LEASE_MS } from "./schedulingReceipts";

vi.mock("./encryption", () => ({
  decrypt: vi.fn(async (value: string) => value.replace(/^encrypted:/, "")),
  encrypt: vi.fn(async (value: string) => `encrypted:${value}`),
}));

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../tonal/${key.slice(2)}` : key] = value;
}

async function seedTarget(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const workoutPlanId = await ctx.db.insert("workoutPlans", {
      userId,
      tonalWorkoutId: "workout-1",
      title: "Push Day",
      blocks: [],
      status: "pushed",
      createdAt: 1,
    });
    return {
      userId,
      workoutPlanId,
      workoutId: "workout-1",
      scheduledDate: "2026-07-30",
    };
  });
}

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;
type Target = Awaited<ReturnType<typeof seedTarget>>;

function getHandler<T>(registered: unknown): T {
  return (registered as { _handler: T })._handler;
}

function makeActionCtx(t: ReturnType<typeof convexTest>): ActionCtx {
  const runQuery = vi.fn(async (ref: TestFunctionReference) => {
    if (getFunctionName(ref) === "tonal/cache:getUserProfile") {
      return {
        tonalToken: "encrypted:access-token",
        tonalRefreshToken: "encrypted:refresh-token",
        tonalUserId: "tonal-user",
      };
    }
    throw new Error(`Unexpected query ${getFunctionName(ref)}`);
  });
  const runMutation = vi.fn(async (ref: TestFunctionReference, args: Record<string, unknown>) => {
    let name: string;
    try {
      name = getFunctionName(ref);
    } catch {
      return { ok: true };
    }
    if (name === "tonal/schedulingReceipts:acquireClaim") {
      return t.mutation(
        internal.tonal.schedulingReceipts.acquireClaim,
        args as Target & { claimId: string; now: number },
      );
    }
    if (name === "tonal/schedulingReceipts:authorizePost") {
      return t.mutation(
        internal.tonal.schedulingReceipts.authorizePost,
        args as Target & { claimId: string; now: number },
      );
    }
    if (name === "tonal/schedulingReceipts:completeClaim") {
      return t.mutation(
        internal.tonal.schedulingReceipts.completeClaim,
        args as Target & { claimId: string; workoutSignupId: string; verifiedAt: number },
      );
    }
    if (name === "tonal/schedulingReceipts:releaseCheckingClaim") {
      return t.mutation(
        internal.tonal.schedulingReceipts.releaseCheckingClaim,
        args as Target & { claimId: string },
      );
    }
    throw new Error(`Unexpected mutation ${name}`);
  });
  return { runQuery, runMutation } as unknown as ActionCtx;
}

const scheduleHandler = getHandler<
  (
    ctx: ActionCtx,
    args: {
      userId: Id<"users">;
      workoutPlanId: Id<"workoutPlans">;
      workoutId: string;
      scheduledDate: string;
    },
  ) => Promise<ScheduleWorkoutResult>
>(scheduleWorkout);

describe("Tonal scheduling claims", () => {
  it("grants exactly one of two simultaneous initial claims", async () => {
    const t = convexTest(schema, modules);
    const target = await seedTarget(t);

    const results = await Promise.all([
      t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
        ...target,
        claimId: "claim-a",
        now: 1_000,
      }),
      t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
        ...target,
        claimId: "claim-b",
        now: 1_000,
      }),
    ]);

    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "busy")).toHaveLength(1);
    expect(results.find((result) => result.status === "acquired")).toMatchObject({
      status: "acquired",
      phase: "checking",
    });
  });

  it("keeps an active post-authorized claim busy", async () => {
    const t = convexTest(schema, modules);
    const target = await seedTarget(t);
    await t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
      ...target,
      claimId: "claim-a",
      now: 1_000,
    });
    await t.mutation(internal.tonal.schedulingReceipts.authorizePost, {
      ...target,
      claimId: "claim-a",
      now: 2_000,
    });

    await expect(
      t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
        ...target,
        claimId: "claim-b",
        now: 2_001,
      }),
    ).resolves.toEqual({ status: "busy", retryable: true });

    const plan = await t.run((ctx) => ctx.db.get(target.workoutPlanId));
    expect(plan?.tonalSchedulingClaim).toMatchObject({
      claimId: "claim-a",
      phase: "post_authorized",
    });
  });

  it("does not fetch or POST when the production handler retries an active post-authorized claim", async () => {
    const t = convexTest(schema, modules);
    const target = await seedTarget(t);
    const now = Date.now();
    await t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
      ...target,
      claimId: "claim-a",
      now,
    });
    await t.mutation(internal.tonal.schedulingReceipts.authorizePost, {
      ...target,
      claimId: "claim-a",
      now,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(scheduleHandler(makeActionCtx(t), target)).resolves.toEqual({
        status: "failed",
        error: "Tonal calendar scheduling is already in progress. Please retry shortly.",
        retryable: true,
      });
      expect(fetchMock).not.toHaveBeenCalled();

      const plan = await t.run((ctx) => ctx.db.get(target.workoutPlanId));
      expect(plan?.tonalSchedulingClaim).toMatchObject({
        claimId: "claim-a",
        phase: "post_authorized",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("turns any expired claim into a reconciliation claim", async () => {
    const t = convexTest(schema, modules);
    const target = await seedTarget(t);
    await t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
      ...target,
      claimId: "claim-a",
      now: 1_000,
    });

    await expect(
      t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
        ...target,
        claimId: "claim-b",
        now: 1_000 + SCHEDULING_CLAIM_LEASE_MS + 1,
      }),
    ).resolves.toEqual({ status: "acquired", phase: "reconciling" });

    const plan = await t.run((ctx) => ctx.db.get(target.workoutPlanId));
    expect(plan?.tonalSchedulingClaim).toMatchObject({
      claimId: "claim-b",
      phase: "reconciling",
    });
  });

  it("does not POST or release reconciliation when an expired claim calendar read fails", async () => {
    const t = convexTest(schema, modules);
    const target = await seedTarget(t);
    await t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
      ...target,
      claimId: "expired-claim",
      now: 1,
    });
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(scheduleHandler(makeActionCtx(t), target)).resolves.toEqual({
        status: "failed",
        error: "Tonal calendar scheduling failed",
        retryable: true,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

      const plan = await t.run((ctx) => ctx.db.get(target.workoutPlanId));
      expect(plan?.tonalSchedulingClaim).toMatchObject({ phase: "reconciling" });
    } finally {
      vi.unstubAllGlobals();
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  it("releases only an initial checking claim", async () => {
    const t = convexTest(schema, modules);
    const target = await seedTarget(t);
    await t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
      ...target,
      claimId: "claim-a",
      now: 1_000,
    });

    await expect(
      t.mutation(internal.tonal.schedulingReceipts.releaseCheckingClaim, {
        ...target,
        claimId: "claim-a",
      }),
    ).resolves.toEqual({ released: true });

    await t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
      ...target,
      claimId: "claim-b",
      now: 2_000,
    });
    await t.mutation(internal.tonal.schedulingReceipts.authorizePost, {
      ...target,
      claimId: "claim-b",
      now: 2_001,
    });
    await expect(
      t.mutation(internal.tonal.schedulingReceipts.releaseCheckingClaim, {
        ...target,
        claimId: "claim-b",
      }),
    ).resolves.toEqual({ released: false });

    const plan = await t.run((ctx) => ctx.db.get(target.workoutPlanId));
    expect(plan?.tonalSchedulingClaim?.phase).toBe("post_authorized");
  });

  it("lets simultaneous production handlers perform at most one POST", async () => {
    const t = convexTest(schema, modules);
    const target = await seedTarget(t);
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    let resolveCalendar!: (response: Response) => void;
    let markCalendarStarted!: () => void;
    const calendarStarted = new Promise<void>((resolve) => {
      markCalendarStarted = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveCalendar = resolve;
            markCalendarStarted();
          }),
      )
      .mockResolvedValueOnce(Response.json({ id: "signup-created" }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const first = scheduleHandler(makeActionCtx(t), target);
      await calendarStarted;
      const second = await scheduleHandler(makeActionCtx(t), target);

      expect(second).toEqual({
        status: "failed",
        error: "Tonal calendar scheduling is already in progress. Please retry shortly.",
        retryable: true,
      });
      resolveCalendar(
        Response.json({ dailySchedules: [{ date: target.scheduledDate, tiles: [] }] }),
      );
      await expect(first).resolves.toEqual({
        status: "scheduled",
        workoutSignupId: "signup-created",
      });
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.TOKEN_ENCRYPTION_KEY;
    }
  });

  it.each([
    { name: "initial checking", movedDate: "2026-07-28", seedExpiredClaim: false },
    { name: "expired reconciliation", movedDate: "2026-08-01", seedExpiredClaim: true },
  ])(
    "persists a moved tile and clears the $name claim without POSTing",
    async ({ movedDate, seedExpiredClaim }) => {
      const t = convexTest(schema, modules);
      const target = await seedTarget(t);
      if (seedExpiredClaim) {
        await t.mutation(internal.tonal.schedulingReceipts.acquireClaim, {
          ...target,
          claimId: "expired-claim",
          now: 1,
        });
      }
      process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          dailySchedules: [
            { date: target.scheduledDate, tiles: [] },
            {
              date: movedDate,
              tiles: [{ workoutId: target.workoutId, workoutSignupId: "signup-moved" }],
            },
          ],
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      try {
        await expect(scheduleHandler(makeActionCtx(t), target)).resolves.toEqual({
          status: "failed",
          error: `Workout is already scheduled on ${movedDate}. Move it in Tonal before scheduling another date.`,
        });
        const plan = await t.run((ctx) => ctx.db.get(target.workoutPlanId));
        expect(plan).toMatchObject({
          tonalWorkoutSignupId: "signup-moved",
          tonalScheduledDate: movedDate,
          tonalSchedulingReceiptVerifiedAt: expect.any(Number),
        });
        expect(plan?.tonalSchedulingClaim).toBeUndefined();
        expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
        const calendarUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
        expect(calendarUrl.searchParams.get("upcomingStartDate")).toBe("2026-07-24");
        expect(calendarUrl.searchParams.get("upcomingEndDate")).toBe("2026-08-05");
      } finally {
        vi.unstubAllGlobals();
        delete process.env.TOKEN_ENCRYPTION_KEY;
      }
    },
  );
});
