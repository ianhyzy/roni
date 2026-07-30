import { v } from "convex/values";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import { rateLimiter } from "../rateLimits";
import { isValidWeekStartDateString } from "../weekPlanHelpers";
import { TonalApiError, tonalFetch } from "./client";
import { withTokenRetry } from "./tokenRetry";

const scheduleWorkoutResultValidator = v.union(
  v.object({ status: v.literal("scheduled"), workoutSignupId: v.string() }),
  v.object({ status: v.literal("already_scheduled"), workoutSignupId: v.string() }),
  v.object({
    status: v.literal("failed"),
    error: v.string(),
    retryable: v.optional(v.boolean()),
  }),
);

export type ScheduleWorkoutResult =
  | { status: "scheduled"; workoutSignupId: string }
  | { status: "already_scheduled"; workoutSignupId: string }
  | { status: "failed"; error: string; retryable?: boolean };

const calendarSchema = z.looseObject({
  dailySchedules: z.array(
    z.looseObject({
      date: z.string(),
      tiles: z.array(
        z.looseObject({
          workoutId: z.string().nullish(),
          workoutSignupId: z.string().trim().min(1).nullish().catch(null),
        }),
      ),
    }),
  ),
});

const signupResponseSchema = z.looseObject({
  id: z.string().trim().min(1).optional(),
  workoutSignupId: z.string().trim().min(1).optional(),
});

interface SchedulingTarget {
  userId: Id<"users">;
  workoutPlanId: Id<"workoutPlans">;
  workoutId: string;
  scheduledDate: string;
}

type ScheduleWorkoutArgs = SchedulingTarget;
type ClaimPhase = "checking" | "reconciling" | "post_authorized";
type CalendarMatch =
  | { status: "absent" }
  | { status: "target"; workoutSignupId: string }
  | { status: "conflict"; scheduledDate: string; workoutSignupId: string };

type SchedulingBoundaryResult<T> =
  { ok: true; value: T } | { ok: false; failure: ScheduleWorkoutResult };

function classifySchedulingBoundaryError(error: unknown): ScheduleWorkoutResult | null {
  if (error instanceof TonalApiError) {
    if (error.status === 401) return null;
    return {
      status: "failed",
      error: `Tonal calendar scheduling failed (status ${error.status})`,
    };
  }
  if (
    error instanceof TypeError ||
    error instanceof SyntaxError ||
    error instanceof z.ZodError ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return { status: "failed", error: "Tonal calendar scheduling failed", retryable: true };
  }
  return null;
}

async function callSchedulingBoundary<T>(
  operation: () => Promise<T>,
): Promise<SchedulingBoundaryResult<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    const failure = classifySchedulingBoundaryError(error);
    if (!failure) throw error;
    return { ok: false, failure };
  }
}

function addUtcDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function calendarPath(tonalUserId: string, scheduledDate: string): string {
  const params = new URLSearchParams({
    upcomingStartDate: addUtcDays(scheduledDate, -6),
    upcomingEndDate: addUtcDays(scheduledDate, 6),
    includeRecentActivities: "true",
    includeRecommendations: "true",
    includeDailyLift: "true",
  });
  return `/v6/users/${tonalUserId}/calendar?${params.toString()}`;
}

async function findWorkoutSignup(options: {
  token: string;
  tonalUserId: string;
  workoutId: string;
  scheduledDate: string;
}): Promise<CalendarMatch> {
  const { token, tonalUserId, workoutId, scheduledDate } = options;
  const payload = await tonalFetch<unknown>(token, calendarPath(tonalUserId, scheduledDate));
  const calendar = calendarSchema.parse(payload);
  let conflict: Extract<CalendarMatch, { status: "conflict" }> | null = null;
  for (const day of calendar.dailySchedules) {
    const tile = day.tiles.find(
      (candidate) => candidate.workoutId === workoutId && candidate.workoutSignupId,
    );
    if (!tile?.workoutSignupId) continue;
    if (day.date === scheduledDate) {
      return { status: "target", workoutSignupId: tile.workoutSignupId };
    }
    conflict ??= {
      status: "conflict",
      scheduledDate: day.date,
      workoutSignupId: tile.workoutSignupId,
    };
  }
  return conflict ?? { status: "absent" };
}

async function releaseInitialCheckingClaim(options: {
  ctx: Pick<ActionCtx, "runMutation">;
  target: SchedulingTarget;
  claimId: string;
  phase: ClaimPhase;
}): Promise<void> {
  const { ctx, target, claimId, phase } = options;
  if (phase !== "checking") return;
  await ctx.runMutation(internal.tonal.schedulingReceipts.releaseCheckingClaim, {
    ...target,
    claimId,
  });
}

async function completeClaim(options: {
  ctx: Pick<ActionCtx, "runMutation">;
  target: SchedulingTarget;
  claimId: string;
  workoutSignupId: string;
  observedScheduledDate?: string;
}): Promise<void> {
  const { ctx, target, claimId, workoutSignupId, observedScheduledDate } = options;
  await ctx.runMutation(internal.tonal.schedulingReceipts.completeClaim, {
    ...target,
    claimId,
    workoutSignupId,
    ...(observedScheduledDate === undefined ? {} : { observedScheduledDate }),
    verifiedAt: Date.now(),
  });
}

function conflictFailure(
  match: Extract<CalendarMatch, { status: "conflict" }>,
): ScheduleWorkoutResult {
  return {
    status: "failed",
    error: `Workout is already scheduled on ${match.scheduledDate}. Move it in Tonal before scheduling another date.`,
  };
}

export async function scheduleWorkoutForUser(
  ctx: ActionCtx,
  { userId, workoutPlanId, workoutId, scheduledDate }: ScheduleWorkoutArgs,
): Promise<ScheduleWorkoutResult> {
  if (workoutId.trim() === "") {
    return { status: "failed", error: "workoutId is required" };
  }
  if (!isValidWeekStartDateString(scheduledDate)) {
    return { status: "failed", error: "scheduledDate must be a valid YYYY-MM-DD date" };
  }

  const target = { userId, workoutPlanId, workoutId, scheduledDate };
  const claimId = crypto.randomUUID();
  const claim = await ctx.runMutation(internal.tonal.schedulingReceipts.acquireClaim, {
    ...target,
    claimId,
    now: Date.now(),
  });
  if (claim.status === "already_scheduled") {
    return { status: "already_scheduled", workoutSignupId: claim.workoutSignupId };
  }
  if (claim.status === "busy") {
    return {
      status: "failed",
      error: "Tonal calendar scheduling is already in progress. Please retry shortly.",
      retryable: true,
    };
  }

  const claimPhase = claim.phase;
  let postAttempted = false;
  try {
    return await withTokenRetry(ctx, userId, async (token, tonalUserId) => {
      const calendarRead = await callSchedulingBoundary(() =>
        findWorkoutSignup({ token, tonalUserId, workoutId, scheduledDate }),
      );
      if (!calendarRead.ok) {
        await releaseInitialCheckingClaim({ ctx, target, claimId, phase: claimPhase });
        return calendarRead.failure;
      }

      const match = calendarRead.value;
      if (match.status === "target") {
        await completeClaim({ ctx, target, claimId, workoutSignupId: match.workoutSignupId });
        return { status: "already_scheduled", workoutSignupId: match.workoutSignupId };
      }
      if (match.status === "conflict") {
        await completeClaim({
          ctx,
          target,
          claimId,
          workoutSignupId: match.workoutSignupId,
          observedScheduledDate: match.scheduledDate,
        });
        return conflictFailure(match);
      }
      if (postAttempted) {
        return {
          status: "failed",
          error: "Tonal scheduling could not be confirmed after authorization. Please retry.",
          retryable: true,
        };
      }

      const rateLimit = await rateLimiter.limit(ctx, "scheduleTonalWorkout", { key: userId });
      if (!rateLimit.ok) {
        await releaseInitialCheckingClaim({ ctx, target, claimId, phase: claimPhase });
        return {
          status: "failed",
          error: "Tonal calendar scheduling is temporarily rate limited. Please retry shortly.",
          retryable: true,
        };
      }

      const authorization = await ctx.runMutation(internal.tonal.schedulingReceipts.authorizePost, {
        ...target,
        claimId,
        now: Date.now(),
      });
      if (!authorization.ok) {
        return {
          status: "failed",
          error: authorization.error,
          retryable: authorization.retryable,
        };
      }

      postAttempted = true;
      const signupRequest = await callSchedulingBoundary(() =>
        tonalFetch<unknown>(
          token,
          `/v6/users/${tonalUserId}/workout-signups?forWorkoutScheduling=true`,
          {
            method: "POST",
            body: { workoutId, plannedDate: `${scheduledDate}T00:00:00.000Z` },
          },
        ),
      );
      if (!signupRequest.ok) return signupRequest.failure;

      const parsedSignup = signupResponseSchema.safeParse(signupRequest.value);
      const createdSignupId = parsedSignup.success
        ? (parsedSignup.data.workoutSignupId ?? parsedSignup.data.id)
        : undefined;
      if (createdSignupId) {
        await completeClaim({ ctx, target, claimId, workoutSignupId: createdSignupId });
        return { status: "scheduled", workoutSignupId: createdSignupId };
      }

      const readback = await callSchedulingBoundary(() =>
        findWorkoutSignup({ token, tonalUserId, workoutId, scheduledDate }),
      );
      if (!readback.ok) return readback.failure;
      if (readback.value.status === "target") {
        await completeClaim({
          ctx,
          target,
          claimId,
          workoutSignupId: readback.value.workoutSignupId,
        });
        return { status: "scheduled", workoutSignupId: readback.value.workoutSignupId };
      }
      if (readback.value.status === "conflict") {
        await completeClaim({
          ctx,
          target,
          claimId,
          workoutSignupId: readback.value.workoutSignupId,
          observedScheduledDate: readback.value.scheduledDate,
        });
        return conflictFailure(readback.value);
      }
      return {
        status: "failed",
        error: `Tonal did not show workout ${workoutId} on ${scheduledDate} after scheduling`,
        retryable: true,
      };
    });
  } catch (error) {
    if (!postAttempted) {
      await releaseInitialCheckingClaim({ ctx, target, claimId, phase: claimPhase });
    }
    if (error instanceof TonalApiError) {
      return {
        status: "failed",
        error: `Tonal calendar scheduling failed (status ${error.status})`,
        retryable: true,
      };
    }
    throw error;
  }
}

export const scheduleWorkout = internalAction({
  args: {
    userId: v.id("users"),
    workoutPlanId: v.id("workoutPlans"),
    workoutId: v.string(),
    scheduledDate: v.string(),
  },
  returns: scheduleWorkoutResultValidator,
  handler: scheduleWorkoutForUser,
});
