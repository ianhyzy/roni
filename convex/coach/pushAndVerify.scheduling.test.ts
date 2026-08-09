import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { scheduleWorkoutForUser, type ScheduleWorkoutResult } from "../tonal/scheduling";
import { pushWeekPlanToTonal } from "./pushAndVerify";
import type { WeekPushResult } from "./pushAndVerifyContract";

vi.mock("../tonal/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tonal/scheduling")>();
  return { ...actual, scheduleWorkoutForUser: vi.fn() };
});
afterEach(() => vi.useRealTimers());
type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;

interface HarnessOptions {
  weekStartDate?: string;
  dayStatus?: "programmed" | "completed";
  workoutStatus?: "draft" | "pushed";
  tonalWorkoutId?: string;
  scheduleResult?: ScheduleWorkoutResult;
  claimConflict?: string;
}

function getHandler<T>(registered: unknown): T {
  return (registered as { _handler: T })._handler;
}

const USER_ID = "user-1" as Id<"users">;
const WEEK_PLAN_ID = "week-plan-1" as Id<"weekPlans">;
const DRAFT_PLAN_ID = "draft-plan-1" as Id<"workoutPlans">;
const PUSHED_PLAN_ID = "pushed-plan-1" as Id<"workoutPlans">;
const FUTURE_WEEK_START = "2099-08-03";

const pushHandler =
  getHandler<
    (
      ctx: ActionCtx,
      args: { userId: Id<"users">; weekPlanId: Id<"weekPlans">; userTimezone?: string },
    ) => Promise<WeekPushResult>
  >(pushWeekPlanToTonal);

function makeHarness(options: HarnessOptions = {}) {
  const scheduleWorkout = vi.mocked(scheduleWorkoutForUser);
  scheduleWorkout.mockReset();
  scheduleWorkout.mockResolvedValue(
    options.scheduleResult ?? { status: "scheduled", workoutSignupId: "signup-1" },
  );
  const workoutStatus = options.workoutStatus ?? "draft";
  const workoutPlanId = workoutStatus === "pushed" ? PUSHED_PLAN_ID : DRAFT_PLAN_ID;
  const runQuery = vi.fn(async (ref: TestFunctionReference) => {
    const name = getFunctionName(ref);
    if (name === "weekPlans:getWeekPlanById") {
      return {
        _id: WEEK_PLAN_ID,
        weekStartDate: options.weekStartDate ?? FUTURE_WEEK_START,
        days: Array.from({ length: 7 }, (_, index) =>
          index === 0
            ? {
                sessionType: "push",
                status: options.dayStatus ?? "programmed",
                workoutPlanId,
              }
            : { sessionType: "rest", status: "programmed" },
        ),
      };
    }
    if (name === "workoutPlans:getById") {
      return {
        _id: workoutPlanId,
        title: "Push – Monday",
        blocks: [{ exercises: [{ movementId: "movement-1", sets: 3, reps: 8 }] }],
        status: workoutStatus,
        ...(workoutStatus === "pushed"
          ? { tonalWorkoutId: options.tonalWorkoutId ?? "tonal-workout-existing" }
          : {}),
      };
    }
    throw new Error(`Unexpected query ${name}`);
  });
  const runAction = vi.fn(async (ref: TestFunctionReference, _args?: Record<string, unknown>) => {
    const name = getFunctionName(ref);
    if (name === "tonal/mutations:createWorkout") {
      return {
        success: true,
        workoutId: "tonal-workout-created",
        title: "Push – Monday",
        setCount: 3,
        planId: PUSHED_PLAN_ID,
        pushDivergence: null,
      };
    }
    if (name === "discord:notifyError") return undefined;
    throw new Error(`Unexpected action ${name}`);
  });
  const runMutation = vi.fn(async (ref: TestFunctionReference) => {
    if (getFunctionName(ref) === "weekPlanApproval:claimDraftForWeekPush") {
      return options.claimConflict
        ? { status: "conflict" as const, error: options.claimConflict }
        : { status: "claimed" as const };
    }
    return { status: "replaced" as const, workoutPlanId: PUSHED_PLAN_ID };
  });
  const ctx = { runQuery, runAction, runMutation } as unknown as ActionCtx;
  return { ctx, runAction, runMutation, scheduleWorkout };
}

function actionNames(runAction: ReturnType<typeof vi.fn>): string[] {
  return runAction.mock.calls.map(([ref]) => getFunctionName(ref as TestFunctionReference));
}

describe("pushWeekPlanToTonal scheduling", () => {
  it("skips a completed week-plan day before loading or scheduling its workout", async () => {
    const { ctx, runAction } = makeHarness({ dayStatus: "completed" });

    const result = await pushHandler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({ success: true, pushed: 0, failed: 0, skipped: 7 });
    expect(result.results[0]).toMatchObject({
      status: "skipped",
      dayName: "Monday",
      sessionType: "push",
    });
    expect(actionNames(runAction)).toEqual([]);
  });

  it("schedules a workout assigned to the user's current local date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T01:00:00.000Z"));
    try {
      const { ctx, runAction } = makeHarness({
        weekStartDate: "2026-07-29",
        workoutStatus: "pushed",
      });

      const result = await pushHandler(ctx, {
        userId: USER_ID,
        weekPlanId: WEEK_PLAN_ID,
        userTimezone: "America/Los_Angeles",
      });

      expect(result).toMatchObject({ success: true, pushed: 1, failed: 0, skipped: 6 });
      expect(result.results[0]).toMatchObject({
        status: "pushed",
        scheduledDate: "2026-07-29",
        scheduleStatus: "scheduled",
      });
      expect(actionNames(runAction)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules a newly pushed workout on its assigned Tonal date", async () => {
    const { ctx, runAction, scheduleWorkout } = makeHarness();

    const result = await pushHandler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({ success: true, pushed: 1, failed: 0, skipped: 6 });
    expect(result.results[0]).toMatchObject({
      status: "pushed",
      tonalWorkoutId: "tonal-workout-created",
      scheduledDate: FUTURE_WEEK_START,
      scheduleStatus: "scheduled",
      workoutSignupId: "signup-1",
    });
    expect(scheduleWorkout).toHaveBeenCalledWith(ctx, {
      userId: USER_ID,
      workoutPlanId: PUSHED_PLAN_ID,
      workoutId: "tonal-workout-created",
      scheduledDate: FUTURE_WEEK_START,
    });
    expect(actionNames(runAction)).toEqual(["tonal/mutations:createWorkout"]);
  });

  it("does not create or schedule when deletion owns the approval fence", async () => {
    const { ctx, runAction, scheduleWorkout } = makeHarness({
      claimConflict: "This week plan is being deleted.",
    });

    const result = await pushHandler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({ success: false, pushed: 0, deferred: 1, skipped: 6 });
    expect(result.results[0]).toMatchObject({
      status: "deferred",
      error: "This week plan is being deleted.",
    });
    expect(actionNames(runAction)).toEqual([]);
    expect(scheduleWorkout).not.toHaveBeenCalled();
  });

  it("retries scheduling for a pushed workout without creating a duplicate", async () => {
    const { ctx, runAction } = makeHarness({
      workoutStatus: "pushed",
      scheduleResult: { status: "already_scheduled", workoutSignupId: "signup-existing" },
    });

    const result = await pushHandler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({ success: true, pushed: 1, failed: 0, skipped: 6 });
    expect(result.results[0]).toMatchObject({
      status: "pushed",
      tonalWorkoutId: "tonal-workout-existing",
      scheduleStatus: "already_scheduled",
      workoutSignupId: "signup-existing",
    });
    expect(actionNames(runAction)).toEqual([]);
  });

  it("keeps a past workout pushed and reports scheduling was skipped", async () => {
    const { ctx, runAction } = makeHarness({ weekStartDate: "2000-01-03" });

    const result = await pushHandler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({ success: true, pushed: 1, failed: 0, skipped: 6 });
    expect(result.results[0]).toMatchObject({
      status: "pushed",
      tonalWorkoutId: "tonal-workout-created",
      scheduledDate: "2000-01-03",
      scheduleStatus: "skipped_past",
    });
    expect(actionNames(runAction)).toEqual(["tonal/mutations:createWorkout"]);
  });

  it("skips rescheduling an already-pushed workout assigned to a past date", async () => {
    const { ctx, runAction } = makeHarness({
      weekStartDate: "2000-01-03",
      workoutStatus: "pushed",
    });

    const result = await pushHandler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({ success: true, pushed: 0, failed: 0, skipped: 7 });
    expect(result.results[0]).toMatchObject({
      status: "skipped",
      tonalWorkoutId: "tonal-workout-existing",
      scheduledDate: "2000-01-03",
      scheduleStatus: "skipped_past",
    });
    expect(actionNames(runAction)).toEqual([]);
  });
});
