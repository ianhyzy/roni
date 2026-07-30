import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { scheduleWorkout, type ScheduleWorkoutResult } from "./scheduling";
import { TonalSessionExpiredError } from "./tokenRetry";

vi.mock("./encryption", () => ({
  decrypt: vi.fn(async (value: string) => value.replace(/^encrypted:/, "")),
  encrypt: vi.fn(async (value: string) => `encrypted:${value}`),
}));

const USER_ID = "test-user" as Id<"users">;
const WORKOUT_PLAN_ID = "workout-plan-1" as Id<"workoutPlans">;
const WORKOUT_ID = "workout-1";
const SCHEDULED_DATE = "2026-07-30";
const TOKEN_PROFILE = {
  tonalToken: "encrypted:access-token",
  tonalRefreshToken: "encrypted:refresh-token",
  tonalUserId: "tonal-user",
};

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;

function getHandler<T>(registered: unknown): T {
  return (registered as { _handler: T })._handler;
}

function makeCtx(
  tokenProfile:
    typeof TOKEN_PROFILE | Omit<typeof TOKEN_PROFILE, "tonalRefreshToken"> = TOKEN_PROFILE,
  completeError?: Error,
): ActionCtx {
  const runQuery = vi.fn(async (ref: TestFunctionReference) => {
    const name = getFunctionName(ref);
    if (name === "tonal/cache:getUserProfile") return tokenProfile;
    throw new Error(`Unexpected query ${name}`);
  });
  const runMutation = vi.fn(async (ref: TestFunctionReference) => {
    let name: string | null = null;
    try {
      name = getFunctionName(ref);
    } catch {
      return { ok: true };
    }
    if (name === "tonal/schedulingReceipts:acquireClaim") {
      return { status: "acquired", phase: "checking" };
    }
    if (name === "tonal/schedulingReceipts:authorizePost") return { ok: true };
    if (name === "tonal/schedulingReceipts:completeClaim" && completeError) throw completeError;
    if (
      name === "tonal/schedulingReceipts:completeClaim" ||
      name === "tonal/schedulingReceipts:releaseCheckingClaim" ||
      name === "userProfiles:markTokenExpired"
    ) {
      return null;
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

const args = {
  userId: USER_ID,
  workoutPlanId: WORKOUT_PLAN_ID,
  workoutId: WORKOUT_ID,
  scheduledDate: SCHEDULED_DATE,
};

describe("scheduleWorkout external failures", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it.each([
    ["the network is unavailable", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "the payload shape is malformed",
      () => Promise.resolve(Response.json({ dailySchedules: "invalid" })),
    ],
    ["the response is malformed JSON", () => Promise.resolve(new Response("not-json"))],
    [
      "the request times out",
      () => Promise.reject(new DOMException("The operation timed out", "TimeoutError")),
    ],
  ])("returns a stable failure when %s", async (_case, request) => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(request));

    await expect(scheduleHandler(makeCtx(), args)).resolves.toEqual({
      status: "failed",
      error: "Tonal calendar scheduling failed",
      retryable: true,
    });
  });

  it("rethrows unexpected receipt persistence errors", async () => {
    const internalError = new Error("Receipt persistence failed");
    const ctx = makeCtx(TOKEN_PROFILE, internalError);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          dailySchedules: [
            {
              date: SCHEDULED_DATE,
              tiles: [{ workoutId: WORKOUT_ID, workoutSignupId: "signup-existing" }],
            },
          ],
        }),
      ),
    );

    await expect(scheduleHandler(ctx, args)).rejects.toBe(internalError);
  });

  it("rethrows session expiry so the reconnect flow remains visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );

    await expect(
      scheduleHandler(makeCtx({ ...TOKEN_PROFILE, tonalRefreshToken: undefined }), args),
    ).rejects.toBeInstanceOf(TonalSessionExpiredError);
  });
});
