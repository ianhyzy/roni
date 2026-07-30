import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { scheduleWorkoutForUser } from "../tonal/scheduling";
import { pushWeekPlanToTonal, START_NEW_DAY_CUTOFF_MS } from "./pushAndVerify";
import type { WeekPushResult } from "./pushAndVerifyContract";

vi.mock("../tonal/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tonal/scheduling")>();
  return { ...actual, scheduleWorkoutForUser: vi.fn() };
});

type TestRef = FunctionReference<"query" | "mutation" | "action", "public" | "internal">;

const USER_ID = "user-1" as Id<"users">;
const WEEK_PLAN_ID = "week-1" as Id<"weekPlans">;

function getHandler<T>(registered: unknown): T {
  return (registered as { _handler: T })._handler;
}

const handler =
  getHandler<
    (
      ctx: ActionCtx,
      args: { userId: Id<"users">; weekPlanId: Id<"weekPlans"> },
    ) => Promise<WeekPushResult>
  >(pushWeekPlanToTonal);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.mocked(scheduleWorkoutForUser).mockReset();
});

describe("pushWeekPlanToTonal failure notifications", () => {
  it("reports a recorded failure even when a later day reaches the deferral cutoff", async () => {
    const startedAt = new Date("2099-08-03T12:00:00.000Z").getTime();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(startedAt)
      .mockReturnValueOnce(startedAt)
      .mockReturnValue(startedAt + START_NEW_DAY_CUTOFF_MS);
    const runQuery = vi.fn(async (ref: TestRef, args?: Record<string, unknown>) => {
      const name = getFunctionName(ref);
      if (name === "weekPlans:getWeekPlanById") {
        return {
          weekStartDate: "2099-08-03",
          days: [
            {
              sessionType: "push",
              status: "programmed",
              workoutPlanId: "draft-0" as Id<"workoutPlans">,
            },
            {
              sessionType: "pull",
              status: "programmed",
              workoutPlanId: "draft-1" as Id<"workoutPlans">,
            },
            ...Array.from({ length: 5 }, () => ({
              sessionType: "rest",
              status: "programmed",
            })),
          ],
        };
      }
      if (name === "workoutPlans:getById") {
        return {
          _id: args?.planId,
          title: "Draft workout",
          blocks: [{ exercises: [{ movementId: "movement-1", sets: 3, reps: 8 }] }],
          status: "draft",
        };
      }
      throw new Error(`Unexpected query ${name}`);
    });
    const runAction = vi.fn(async (ref: TestRef) => {
      const name = getFunctionName(ref);
      if (name === "tonal/mutations:createWorkout") {
        return { success: false, error: "Tonal create failed", planId: "failed-plan" };
      }
      if (name === "discord:notifyError") return undefined;
      throw new Error(`Unexpected action ${name}`);
    });
    const ctx = {
      runQuery,
      runAction,
      runMutation: vi.fn(),
    } as unknown as ActionCtx;

    const result = await handler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({
      success: false,
      failed: 1,
      deferred: 1,
      skipped: 5,
    });
    expect(result.results.slice(0, 2)).toMatchObject([
      { status: "failed", error: "Tonal create failed" },
      { status: "deferred", retryable: true },
    ]);
    const actionNames = runAction.mock.calls.map(([ref]) => getFunctionName(ref));
    expect(actionNames).toEqual([
      "tonal/mutations:createWorkout",
      "tonal/mutations:createWorkout",
      "discord:notifyError",
    ]);
  });

  it("reports a scheduling failure even when a later day reaches the deferral cutoff", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2099-08-03T12:00:00.000Z");
    vi.setSystemTime(startedAt);
    const scheduleWorkout = vi.mocked(scheduleWorkoutForUser);
    scheduleWorkout.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(startedAt.getTime() + START_NEW_DAY_CUTOFF_MS));
      return { status: "failed", error: "Tonal scheduling failed", retryable: true };
    });
    const runQuery = vi.fn(async (ref: TestRef, args?: Record<string, unknown>) => {
      const name = getFunctionName(ref);
      if (name === "weekPlans:getWeekPlanById") {
        return {
          weekStartDate: "2099-08-03",
          days: [
            {
              sessionType: "push",
              status: "programmed",
              workoutPlanId: "pushed-0" as Id<"workoutPlans">,
            },
            {
              sessionType: "pull",
              status: "programmed",
              workoutPlanId: "pushed-1" as Id<"workoutPlans">,
            },
            ...Array.from({ length: 5 }, () => ({
              sessionType: "rest",
              status: "programmed",
            })),
          ],
        };
      }
      if (name === "workoutPlans:getById") {
        return {
          _id: args?.planId,
          title: "Pushed workout",
          blocks: [{ exercises: [{ movementId: "movement-1", sets: 3, reps: 8 }] }],
          status: "pushed",
          tonalWorkoutId: `tonal-${String(args?.planId)}`,
        };
      }
      throw new Error(`Unexpected query ${name}`);
    });
    const runAction = vi.fn(async (ref: TestRef) => {
      const name = getFunctionName(ref);
      if (name === "discord:notifyError") return undefined;
      throw new Error(`Unexpected action ${name}`);
    });
    const ctx = {
      runQuery,
      runAction,
      runMutation: vi.fn(),
    } as unknown as ActionCtx;

    const result = await handler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(result).toMatchObject({
      success: false,
      pushed: 1,
      schedulingFailed: 1,
      deferred: 1,
      skipped: 5,
    });
    expect(result.results.slice(0, 2)).toMatchObject([
      {
        status: "pushed",
        scheduleStatus: "failed",
        error: "Tonal scheduling failed",
        retryable: true,
      },
      { status: "deferred", retryable: true },
    ]);
    expect(scheduleWorkout).toHaveBeenCalledOnce();
    expect(runAction.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual([
      "discord:notifyError",
    ]);
  });
});
