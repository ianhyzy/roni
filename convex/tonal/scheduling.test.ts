import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { scheduleWorkout, type ScheduleWorkoutResult } from "./scheduling";

vi.mock("./encryption", () => ({
  decrypt: vi.fn(async (value: string) => value.replace(/^encrypted:/, "")),
  encrypt: vi.fn(async (value: string) => `encrypted:${value}`),
}));

vi.mock("./auth", () => ({
  refreshTonalToken: vi.fn(async () => ({
    idToken: "refreshed-access-token",
    refreshToken: "refreshed-refresh-token",
    expiresAt: 2_000_000,
  })),
}));

const USER_ID = "test-user" as Id<"users">;
const WORKOUT_PLAN_ID = "workout-plan-1" as Id<"workoutPlans">;
const TONAL_USER_ID = "tonal-user";
const WORKOUT_ID = "workout-1";
const SCHEDULED_DATE = "2026-07-30";
const TOKEN_PROFILE = {
  tonalToken: "encrypted:access-token",
  tonalRefreshToken: "encrypted:refresh-token",
  tonalUserId: TONAL_USER_ID,
};

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;
type AcquireResult =
  | { status: "already_scheduled"; workoutSignupId: string }
  | { status: "acquired"; phase: "checking" | "reconciling" }
  | { status: "busy"; retryable: true };

interface HarnessOptions {
  acquireResult?: AcquireResult;
  rateLimitResult?: { ok: boolean; retryAfter?: number };
}

function getHandler<T>(registered: unknown): T {
  return (registered as { _handler: T })._handler;
}

function tryGetFunctionName(ref: TestFunctionReference): string | null {
  try {
    return getFunctionName(ref);
  } catch {
    return null;
  }
}

function makeCtx(options: HarnessOptions = {}) {
  const runQuery = vi.fn(async (ref: TestFunctionReference) => {
    const name = getFunctionName(ref);
    if (name === "tonal/cache:getUserProfile") return TOKEN_PROFILE;
    throw new Error(`Unexpected query ${name}`);
  });
  const runMutation = vi.fn(async (ref: TestFunctionReference) => {
    const name = tryGetFunctionName(ref);
    if (name === "tonal/schedulingReceipts:acquireClaim") {
      return options.acquireResult ?? { status: "acquired", phase: "checking" };
    }
    if (name === "tonal/schedulingReceipts:authorizePost") return { ok: true };
    if (
      name === "tonal/schedulingReceipts:completeClaim" ||
      name === "tonal/schedulingReceipts:releaseCheckingClaim" ||
      name === "userProfiles:updateTonalToken" ||
      name === "userProfiles:releaseTokenRefreshLock"
    ) {
      return null;
    }
    if (name === "userProfiles:acquireTokenRefreshLock") return true;
    if (name === "userProfiles:markTokenExpired") return null;
    if (name === null) return options.rateLimitResult ?? { ok: true };
    throw new Error(`Unexpected mutation ${name}`);
  });
  return {
    ctx: { runQuery, runMutation } as unknown as ActionCtx,
    runMutation,
  };
}

function calendarResponse(
  schedules: Array<{
    date: string;
    tiles: Array<{ workoutId: string | null; workoutSignupId: string | null }>;
  }>,
) {
  return Response.json({ dailySchedules: schedules });
}

function emptyTargetCalendar() {
  return calendarResponse([{ date: SCHEDULED_DATE, tiles: [] }]);
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

const args = {
  userId: USER_ID,
  workoutPlanId: WORKOUT_PLAN_ID,
  workoutId: WORKOUT_ID,
  scheduledDate: SCHEDULED_DATE,
};

describe("scheduleWorkout", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("uses a fresh matching receipt without fetching Tonal", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      scheduleHandler(
        makeCtx({
          acquireResult: {
            status: "already_scheduled",
            workoutSignupId: "signup-fresh",
          },
        }).ctx,
        args,
      ),
    ).resolves.toEqual({ status: "already_scheduled", workoutSignupId: "signup-fresh" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a retryable result for an active claim with zero Tonal work", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      scheduleHandler(makeCtx({ acquireResult: { status: "busy", retryable: true } }).ctx, args),
    ).resolves.toEqual({
      status: "failed",
      error: "Tonal calendar scheduling is already in progress. Please retry shortly.",
      retryable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not POST when the calendar read fails and releases only initial checking", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, runMutation } = makeCtx();

    await expect(scheduleHandler(ctx, args)).resolves.toEqual({
      status: "failed",
      error: "Tonal calendar scheduling failed",
      retryable: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(
      runMutation.mock.calls.some(
        ([ref]) =>
          tryGetFunctionName(ref as TestFunctionReference) ===
          "tonal/schedulingReceipts:releaseCheckingClaim",
      ),
    ).toBe(true);
  });

  it("reconciles an expired claim from a matching tile without POSTing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      calendarResponse([
        {
          date: SCHEDULED_DATE,
          tiles: [{ workoutId: WORKOUT_ID, workoutSignupId: "signup-existing" }],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, runMutation } = makeCtx({
      acquireResult: { status: "acquired", phase: "reconciling" },
    });

    await expect(scheduleHandler(ctx, args)).resolves.toEqual({
      status: "already_scheduled",
      workoutSignupId: "signup-existing",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[1]).not.toMatchObject({ method: "POST" });
    expect(
      runMutation.mock.calls.some(
        ([ref]) =>
          tryGetFunctionName(ref as TestFunctionReference) ===
          "tonal/schedulingReceipts:completeClaim",
      ),
    ).toBe(true);
  });

  it("reposts once after an expired claim and a confirmed live absence", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyTargetCalendar())
      .mockResolvedValueOnce(Response.json({ id: "signup-created" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      scheduleHandler(
        makeCtx({ acquireResult: { status: "acquired", phase: "reconciling" } }).ctx,
        args,
      ),
    ).resolves.toEqual({ status: "scheduled", workoutSignupId: "signup-created" });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("reposts a stale removed receipt after the calendar confirms absence", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyTargetCalendar())
      .mockResolvedValueOnce(Response.json({ workoutSignupId: "signup-recreated" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(scheduleHandler(makeCtx().ctx, args)).resolves.toEqual({
      status: "scheduled",
      workoutSignupId: "signup-recreated",
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("returns a moved-tile conflict without POSTing", async () => {
    const movedDate = "2026-08-01";
    const fetchMock = vi.fn().mockResolvedValue(
      calendarResponse([
        { date: SCHEDULED_DATE, tiles: [] },
        {
          date: movedDate,
          tiles: [{ workoutId: WORKOUT_ID, workoutSignupId: "signup-moved" }],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(scheduleHandler(makeCtx().ctx, args)).resolves.toEqual({
      status: "failed",
      error: `Workout is already scheduled on ${movedDate}. Move it in Tonal before scheduling another date.`,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("prefers an exact target tile over an earlier matching tile", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      calendarResponse([
        {
          date: "2026-07-28",
          tiles: [{ workoutId: WORKOUT_ID, workoutSignupId: "signup-earlier" }],
        },
        {
          date: SCHEDULED_DATE,
          tiles: [{ workoutId: WORKOUT_ID, workoutSignupId: "signup-target" }],
        },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(scheduleHandler(makeCtx().ctx, args)).resolves.toEqual({
      status: "already_scheduled",
      workoutSignupId: "signup-target",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never repeats POST when token refresh follows an ambiguous POST 401", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyTargetCalendar())
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(emptyTargetCalendar());
    vi.stubGlobal("fetch", fetchMock);

    await expect(scheduleHandler(makeCtx().ctx, args)).resolves.toEqual({
      status: "failed",
      error: "Tonal scheduling could not be confirmed after authorization. Please retry.",
      retryable: true,
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("rejects invalid input before acquiring a claim", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, runMutation } = makeCtx();

    await expect(scheduleHandler(ctx, { ...args, scheduledDate: "2026-02-30" })).resolves.toEqual({
      status: "failed",
      error: "scheduledDate must be a valid YYYY-MM-DD date",
    });
    expect(runMutation).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
