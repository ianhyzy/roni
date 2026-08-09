import { type FunctionReference, getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { scheduleWorkoutForUser } from "../tonal/scheduling";
import { getWorkoutApprovalFingerprint } from "../weekPlanHelpers";
import { pushWeekPlanToTonal } from "./pushAndVerify";
import type { WeekPushResult } from "./pushAndVerifyContract";

vi.mock("../tonal/scheduling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tonal/scheduling")>();
  return { ...actual, scheduleWorkoutForUser: vi.fn() };
});

type TestRef = FunctionReference<"query" | "mutation" | "action", "public" | "internal">;
type Replacement =
  | { status: "canonical"; workoutPlanId: Id<"workoutPlans"> }
  | { status: "conflict"; error: string };

const USER_ID = "user-1" as Id<"users">;
const WEEK_PLAN_ID = "week-1" as Id<"weekPlans">;
const DRAFT_ID = "draft-1" as Id<"workoutPlans">;
const LOSER_ID = "loser-1" as Id<"workoutPlans">;
const CANONICAL_ID = "canonical-1" as Id<"workoutPlans">;
const DRAFT_SNAPSHOT = {
  title: "Draft workout",
  blocks: [{ exercises: [{ movementId: "draft-movement", sets: 3, reps: 8 }] }],
};
const STALE_DRAFT_ERROR =
  "The draft changed while approval was in progress. Retry approval to push the updated workout.";

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

function makeContext(replacement: Replacement, canonicalStatus: "pushed" | "draft" | "missing") {
  const runQuery = vi.fn(async (ref: TestRef, args?: Record<string, unknown>) => {
    const name = getFunctionName(ref);
    if (name === "weekPlans:getWeekPlanById") {
      return {
        weekStartDate: "2099-08-03",
        days: [
          { sessionType: "push", status: "programmed", workoutPlanId: DRAFT_ID },
          ...Array.from({ length: 6 }, () => ({ sessionType: "rest", status: "programmed" })),
        ],
      };
    }
    if (name === "workoutPlans:getById" && args?.planId === DRAFT_ID) {
      return {
        _id: DRAFT_ID,
        ...DRAFT_SNAPSHOT,
        status: "draft",
      };
    }
    if (name === "workoutPlans:getById" && args?.planId === CANONICAL_ID) {
      if (canonicalStatus === "missing") return null;
      return {
        _id: CANONICAL_ID,
        title: "Canonical workout",
        blocks: [
          {
            exercises: [
              { movementId: "canonical-1", sets: 3, reps: 8 },
              { movementId: "canonical-2", sets: 3, reps: 10 },
            ],
          },
        ],
        status: canonicalStatus,
        ...(canonicalStatus === "pushed" ? { tonalWorkoutId: "tonal-canonical" } : {}),
      };
    }
    throw new Error(`Unexpected query ${name}`);
  });
  const runAction = vi.fn(async (ref: TestRef) => {
    const name = getFunctionName(ref);
    if (name === "tonal/mutations:createWorkout") {
      return {
        success: true,
        workoutId: "tonal-loser",
        title: "Losing workout",
        setCount: 3,
        planId: LOSER_ID,
        pushDivergence: {
          missingMovements: ["Loser-only divergence"],
          extraMovements: [],
          setCountMismatches: [],
        },
      };
    }
    if (name === "discord:notifyError") return undefined;
    throw new Error(`Unexpected action ${name}`);
  });
  const runMutation = vi.fn(async (ref: TestRef) =>
    getFunctionName(ref) === "weekPlanApproval:claimDraftForWeekPush"
      ? { status: "claimed" as const }
      : replacement,
  );
  return {
    ctx: { runQuery, runAction, runMutation } as unknown as ActionCtx,
    runMutation,
  };
}

describe("pushWeekPlanToTonal concurrent draft replacement", () => {
  beforeEach(() => {
    vi.mocked(scheduleWorkoutForUser).mockReset();
    vi.mocked(scheduleWorkoutForUser).mockResolvedValue({
      status: "scheduled",
      workoutSignupId: "signup-1",
    });
  });

  it("schedules only the canonical pushed plan when this approval loses the CAS", async () => {
    const { ctx, runMutation } = makeContext(
      { status: "canonical", workoutPlanId: CANONICAL_ID },
      "pushed",
    );

    const result = await handler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
      userId: USER_ID,
      weekPlanId: WEEK_PLAN_ID,
      dayIndex: 0,
      oldWorkoutPlanId: DRAFT_ID,
      expectedDraftFingerprint: getWorkoutApprovalFingerprint(DRAFT_SNAPSHOT),
      newWorkoutPlanId: LOSER_ID,
      estimatedDuration: undefined,
    });
    expect(scheduleWorkoutForUser).toHaveBeenCalledOnce();
    expect(scheduleWorkoutForUser).toHaveBeenCalledWith(ctx, {
      userId: USER_ID,
      workoutPlanId: CANONICAL_ID,
      workoutId: "tonal-canonical",
      scheduledDate: "2099-08-03",
    });
    expect(result.results[0]).toMatchObject({
      status: "pushed",
      title: "Canonical workout",
      tonalWorkoutId: "tonal-canonical",
      exerciseCount: 2,
    });
    expect(result.results[0].pushDivergence).toBeUndefined();
  });

  it.each(["missing", "draft"] as const)(
    "defers without a calendar call when the canonical plan is %s",
    async (canonicalStatus) => {
      const { ctx } = makeContext(
        { status: "canonical", workoutPlanId: CANONICAL_ID },
        canonicalStatus,
      );

      const result = await handler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

      expect(result).toMatchObject({ success: false, pushed: 0, deferred: 1, skipped: 6 });
      expect(result.results[0]).toMatchObject({ status: "deferred", retryable: true });
      expect(scheduleWorkoutForUser).not.toHaveBeenCalled();
    },
  );

  it("defers without a calendar call when the replacement conflicts", async () => {
    const { ctx, runMutation } = makeContext(
      { status: "conflict", error: STALE_DRAFT_ERROR },
      "missing",
    );

    const result = await handler(ctx, { userId: USER_ID, weekPlanId: WEEK_PLAN_ID });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        expectedDraftFingerprint: getWorkoutApprovalFingerprint(DRAFT_SNAPSHOT),
      }),
    );
    expect(result.results[0]).toMatchObject({
      status: "deferred",
      retryable: true,
      error: STALE_DRAFT_ERROR,
    });
    expect(scheduleWorkoutForUser).not.toHaveBeenCalled();
  });
});
