import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { PushDivergence } from "../tonal/mutations";
import { scheduleWorkoutForUser, type ScheduleWorkoutResult } from "../tonal/scheduling";
import { pushWeekPlanToTonal, START_NEW_DAY_CUTOFF_MS } from "./pushAndVerify";
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
  pushDivergence?: PushDivergence | null;
  createFailure?: string;
  eligibleDays?: number;
  workoutStatusesByLookup?: readonly ("draft" | "pushed" | "completed" | "missing")[];
  reachCutoffBeforeDays?: boolean;
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
  let workoutLookupIndex = 0;
  const runQuery = vi.fn(async (ref: TestFunctionReference) => {
    const name = getFunctionName(ref);
    if (name === "weekPlans:getWeekPlanById") {
      if (options.reachCutoffBeforeDays) {
        vi.setSystemTime(new Date(Date.now() + START_NEW_DAY_CUTOFF_MS));
      }
      return {
        _id: WEEK_PLAN_ID,
        weekStartDate: options.weekStartDate ?? FUTURE_WEEK_START,
        days: Array.from({ length: 7 }, (_, index) =>
          index < (options.eligibleDays ?? 1)
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
      const lookupStatus = options.workoutStatusesByLookup?.[workoutLookupIndex++] ?? workoutStatus;
      if (lookupStatus === "missing") return null;
      return {
        _id: workoutPlanId,
        title: "Push – Monday",
        blocks: [{ exercises: [{ movementId: "movement-1", sets: 3, reps: 8 }] }],
        status: lookupStatus,
        ...(lookupStatus === "pushed"
          ? { tonalWorkoutId: options.tonalWorkoutId ?? "tonal-workout-existing" }
          : {}),
      };
    }
    throw new Error(`Unexpected query ${name}`);
  });
  const runAction = vi.fn(async (ref: TestFunctionReference, _args?: Record<string, unknown>) => {
    const name = getFunctionName(ref);
    if (name === "tonal/mutations:createWorkout") {
      if (options.createFailure) {
        return { success: false, error: options.createFailure, planId: DRAFT_PLAN_ID };
      }
      return {
        success: true,
        workoutId: "tonal-workout-created",
        title: "Push – Monday",
        setCount: 3,
        planId: PUSHED_PLAN_ID,
        pushDivergence: options.pushDivergence ?? null,
      };
    }
    if (name === "discord:notifyError") return undefined;
    throw new Error(`Unexpected action ${name}`);
  });
  const runMutation = vi.fn(async () => ({
    status: "replaced" as const,
    workoutPlanId: PUSHED_PLAN_ID,
  }));
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

  it("reports calendar failure after preserving the created workout", async () => {
    const pushDivergence: PushDivergence = {
      missingMovements: ["Bench Press"],
      extraMovements: [],
      setCountMismatches: [],
    };
    const { ctx, runAction, runMutation } = makeHarness({
      pushDivergence,
      scheduleResult: {
        status: "failed",
        error: "Tonal calendar scheduling failed (status 400)",
      },
    });

    const result = await pushHandler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({
      success: false,
      pushed: 1,
      failed: 0,
      schedulingFailed: 1,
      skipped: 6,
    });
    expect(result.results[0]).toMatchObject({
      status: "pushed",
      tonalWorkoutId: "tonal-workout-created",
      scheduleStatus: "failed",
      error: "Tonal calendar scheduling failed (status 400)",
      pushDivergence,
    });
    expect(runMutation).toHaveBeenCalledOnce();
    expect(actionNames(runAction)).toEqual([
      "tonal/mutations:createWorkout",
      "discord:notifyError",
    ]);
  });

  it("counts workout creation failure separately from calendar failure", async () => {
    const { ctx, runAction, scheduleWorkout } = makeHarness({
      createFailure: "Tonal workout creation failed",
    });

    const result = await pushHandler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({
      success: false,
      pushed: 0,
      failed: 1,
      schedulingFailed: 0,
      skipped: 6,
    });
    expect(result.results[0]).toMatchObject({
      status: "failed",
      error: "Tonal workout creation failed",
    });
    expect(result.results[0]).not.toHaveProperty("tonalWorkoutId");
    expect(scheduleWorkout).not.toHaveBeenCalled();
    expect(actionNames(runAction)).toEqual([
      "tonal/mutations:createWorkout",
      "tonal/mutations:createWorkout",
      "discord:notifyError",
    ]);
  });

  it("defers remaining eligible days after the safe start-work cutoff", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2099-08-03T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { ctx, runAction, scheduleWorkout } = makeHarness({
      workoutStatus: "pushed",
      eligibleDays: 3,
    });
    scheduleWorkout.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(startedAt.getTime() + START_NEW_DAY_CUTOFF_MS));
      return { status: "scheduled", workoutSignupId: "signup-1" };
    });

    const result = await pushHandler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({
      success: false,
      pushed: 1,
      failed: 0,
      schedulingFailed: 0,
      deferred: 2,
      skipped: 4,
    });
    expect(result.results.slice(1, 3)).toMatchObject([
      { dayIndex: 1, dayName: "Tuesday", status: "deferred", retryable: true },
      { dayIndex: 2, dayName: "Wednesday", status: "deferred", retryable: true },
    ]);
    expect(result.results[1].error).toContain("Retry to finish this day safely");
    expect(scheduleWorkout).toHaveBeenCalledOnce();
    expect(actionNames(runAction)).toEqual([]);
  });

  it("defers eligible days without external calls when the cutoff is reached before day work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-08-03T12:00:00.000Z"));
    const { ctx, runAction, scheduleWorkout } = makeHarness({
      workoutStatus: "pushed",
      eligibleDays: 3,
      reachCutoffBeforeDays: true,
    });

    const result = await pushHandler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({
      success: false,
      pushed: 0,
      failed: 0,
      schedulingFailed: 0,
      deferred: 3,
      skipped: 4,
    });
    expect(result.results.map(({ status }) => status)).toEqual([
      "deferred",
      "deferred",
      "deferred",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(result.results.slice(0, 3).every((day) => day.retryable)).toBe(true);
    expect(scheduleWorkout).not.toHaveBeenCalled();
    expect(actionNames(runAction)).toEqual([]);
  });

  it("still skips completed and missing workouts after the safe start-work cutoff", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2099-08-03T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { ctx, runAction, scheduleWorkout } = makeHarness({
      workoutStatus: "pushed",
      eligibleDays: 3,
      workoutStatusesByLookup: ["pushed", "completed", "missing"],
    });
    scheduleWorkout.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(startedAt.getTime() + START_NEW_DAY_CUTOFF_MS));
      return { status: "scheduled", workoutSignupId: "signup-1" };
    });

    const result = await pushHandler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({
      success: true,
      pushed: 1,
      failed: 0,
      schedulingFailed: 0,
      deferred: 0,
      skipped: 6,
    });
    expect(result.results.slice(1, 3)).toMatchObject([
      { dayName: "Tuesday", status: "skipped", title: "Push – Monday" },
      { dayName: "Wednesday", status: "skipped" },
    ]);
    expect(scheduleWorkout).toHaveBeenCalledOnce();
    expect(actionNames(runAction)).toEqual([]);
  });
});
