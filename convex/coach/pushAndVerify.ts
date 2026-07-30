/** Push every eligible week-plan workout to Tonal and report each outcome. */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { DAY_NAMES } from "./weekProgrammingHelpers";
import type { BlockInput } from "../tonal/transforms";
import type { PushDivergence } from "../tonal/mutations";
import { scheduleWorkoutForUser } from "../tonal/scheduling";
import { getWorkoutApprovalFingerprint } from "../weekPlanHelpers";
import {
  type PushResult,
  type WeekPushResult,
  weekPushResultValidator,
} from "./pushAndVerifyContract";

const CONVEX_ACTION_LIMIT_MS = 600_000;
// Two createWorkout attempts can each exhaust Tonal's 30s POST retries and
// backoffs, then scheduling may need a refreshed-token reconciliation pass.
const MAX_DAY_OPERATION_MS = 360_000;
const FINALIZATION_MARGIN_MS = 30_000;
export const START_NEW_DAY_CUTOFF_MS =
  CONVEX_ACTION_LIMIT_MS - MAX_DAY_OPERATION_MS - FINALIZATION_MARGIN_MS;
const DEFERRED_MESSAGE = "Approval is still in progress. Retry to finish this day safely.";

type CreateWorkoutResult =
  | {
      success: true;
      workoutId: string;
      title: string;
      setCount: number;
      planId: Id<"workoutPlans">;
      pushDivergence: PushDivergence | null;
    }
  | { success: false; error: string; planId: Id<"workoutPlans"> };

type WorkoutPlan = {
  _id: Id<"workoutPlans">;
  title: string;
  blocks: BlockInput[];
  status: string;
  tonalWorkoutId?: string;
};

type WeekPlanDay = {
  sessionType: string;
  status: string;
  workoutPlanId?: Id<"workoutPlans">;
  estimatedDuration?: number;
};

type WeekPlan = {
  weekStartDate: string;
  days: WeekPlanDay[];
};

type DraftReplacementResult =
  | { status: "replaced"; workoutPlanId: Id<"workoutPlans"> }
  | { status: "canonical"; workoutPlanId: Id<"workoutPlans"> }
  | { status: "conflict"; error: string };

/** Push a single draft workout to Tonal, retrying once on failure. */
async function pushOneWorkout(
  ctx: Pick<ActionCtx, "runAction">,
  userId: Id<"users">,
  wp: WorkoutPlan,
): Promise<CreateWorkoutResult> {
  const push = () =>
    ctx.runAction(internal.tonal.mutations.createWorkout, {
      userId,
      title: wp.title,
      blocks: wp.blocks,
    }) as Promise<CreateWorkoutResult>;

  const first = await push();
  if (first.success) return first;

  // Single retry
  return push();
}

function countExercises(blocks: BlockInput[]): number {
  let count = 0;
  for (const block of blocks) {
    count += block.exercises.length;
  }
  return count;
}

function getScheduledDate(weekStartDate: string, dayIndex: number): string {
  const date = new Date(`${weekStartDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + dayIndex);
  return date.toISOString().slice(0, 10);
}

function isPastDate(
  date: string,
  userTimezone: string | undefined,
  now: Date = new Date(),
): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: userTimezone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return date < `${year}-${month}-${day}`;
  } catch {
    // Invalid or unavailable timezones use the existing UTC behavior.
  }
  return date < now.toISOString().slice(0, 10);
}

export const pushWeekPlanToTonal = internalAction({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    userTimezone: v.optional(v.string()),
  },
  returns: weekPushResultValidator,
  handler: async (ctx, { userId, weekPlanId, userTimezone }): Promise<WeekPushResult> => {
    const startNewWorkDeadline = Date.now() + START_NEW_DAY_CUTOFF_MS;
    const plan = (await ctx.runQuery(internal.weekPlans.getWeekPlanById, {
      weekPlanId,
      userId,
    })) as WeekPlan | null;

    if (!plan) {
      return {
        success: false,
        pushed: 0,
        failed: 0,
        schedulingFailed: 0,
        deferred: 0,
        skipped: 0,
        results: [],
      };
    }

    const results: PushResult[] = [];
    let pushed = 0;
    let failed = 0;
    let schedulingFailed = 0;
    let deferred = 0;
    let skipped = 0;
    let createdWorkouts = 0;
    let hasReportableFailure = false;

    for (let i = 0; i < plan.days.length; i++) {
      const day = plan.days[i];
      const dayName = DAY_NAMES[i];

      if (
        day.status === "completed" ||
        day.sessionType === "rest" ||
        day.sessionType === "recovery" ||
        !day.workoutPlanId
      ) {
        results.push({
          dayIndex: i,
          dayName,
          sessionType: day.sessionType,
          status: "skipped",
        });
        skipped++;
        continue;
      }

      // Load the workout plan to check its status
      const wp = (await ctx.runQuery(internal.workoutPlans.getById, {
        planId: day.workoutPlanId,
        userId,
      })) as WorkoutPlan | null;

      if (!wp) {
        results.push({
          dayIndex: i,
          dayName,
          sessionType: day.sessionType,
          status: "skipped",
        });
        skipped++;
        continue;
      }

      if (wp.status === "completed") {
        results.push({
          dayIndex: i,
          dayName,
          sessionType: day.sessionType,
          status: "skipped",
          title: wp.title,
        });
        skipped++;
        continue;
      }

      if (Date.now() >= startNewWorkDeadline) {
        results.push({
          dayIndex: i,
          dayName,
          sessionType: day.sessionType,
          status: "deferred",
          error: DEFERRED_MESSAGE,
          retryable: true,
        });
        deferred++;
        continue;
      }

      let tonalWorkoutId = wp.tonalWorkoutId;
      let pushedWorkoutPlanId = wp._id;
      let title = wp.title;
      let blocks = wp.blocks;
      let pushDivergence: PushDivergence | null | undefined;
      let createdThisRun = false;

      if (wp.status !== "pushed") {
        // Gap between creations to stay under Tonal's per-user rate limit.
        if (createdWorkouts > 0) await new Promise((resolve) => setTimeout(resolve, 5000));

        const expectedDraftFingerprint = getWorkoutApprovalFingerprint(wp);
        const createResult = await pushOneWorkout(ctx, userId, wp);
        if (!createResult.success) {
          results.push({
            dayIndex: i,
            dayName,
            sessionType: day.sessionType,
            status: "failed",
            title: wp.title,
            error: createResult.error,
          });
          hasReportableFailure = true;
          failed++;
          continue;
        }

        createdWorkouts++;
        const replacement = (await ctx.runMutation(internal.weekPlans.replaceDraftWithPushed, {
          userId,
          weekPlanId,
          dayIndex: i,
          oldWorkoutPlanId: wp._id,
          expectedDraftFingerprint,
          newWorkoutPlanId: createResult.planId,
          estimatedDuration: day.estimatedDuration,
        })) as DraftReplacementResult;
        if (replacement.status === "conflict") {
          results.push({
            dayIndex: i,
            dayName,
            sessionType: day.sessionType,
            status: "deferred",
            error: replacement.error,
            retryable: true,
          });
          deferred++;
          continue;
        }
        if (replacement.status === "canonical") {
          const canonical = (await ctx.runQuery(internal.workoutPlans.getById, {
            planId: replacement.workoutPlanId,
            userId,
          })) as WorkoutPlan | null;
          if (!canonical || canonical.status !== "pushed" || !canonical.tonalWorkoutId) {
            results.push({
              dayIndex: i,
              dayName,
              sessionType: day.sessionType,
              status: "deferred",
              error: DEFERRED_MESSAGE,
              retryable: true,
            });
            deferred++;
            continue;
          }
          tonalWorkoutId = canonical.tonalWorkoutId;
          pushedWorkoutPlanId = canonical._id;
          title = canonical.title;
          blocks = canonical.blocks;
        } else {
          tonalWorkoutId = createResult.workoutId;
          pushedWorkoutPlanId = createResult.planId;
          title = createResult.title;
          pushDivergence = createResult.pushDivergence;
          createdThisRun = true;
        }
      }

      if (!tonalWorkoutId) {
        results.push({
          dayIndex: i,
          dayName,
          sessionType: day.sessionType,
          status: "skipped",
          title,
        });
        skipped++;
        continue;
      }

      const scheduledDate = getScheduledDate(plan.weekStartDate, i);
      const baseResult = {
        dayIndex: i,
        dayName,
        sessionType: day.sessionType,
        title,
        tonalWorkoutId,
        exerciseCount: countExercises(blocks),
        ...(pushDivergence !== undefined ? { pushDivergence } : {}),
        scheduledDate,
      };

      if (isPastDate(scheduledDate, userTimezone)) {
        results.push({
          ...baseResult,
          status: createdThisRun ? "pushed" : "skipped",
          scheduleStatus: "skipped_past",
        });
        if (createdThisRun) pushed++;
        else skipped++;
        continue;
      }

      const scheduleResult = await scheduleWorkoutForUser(ctx, {
        userId,
        workoutPlanId: pushedWorkoutPlanId,
        workoutId: tonalWorkoutId,
        scheduledDate,
      });
      if (scheduleResult.status === "failed") {
        results.push({
          ...baseResult,
          status: "pushed",
          error: scheduleResult.error,
          scheduleStatus: "failed",
          ...(scheduleResult.retryable === undefined
            ? {}
            : { retryable: scheduleResult.retryable }),
        });
        hasReportableFailure = true;
        pushed++;
        schedulingFailed++;
        continue;
      }

      results.push({
        ...baseResult,
        status: "pushed",
        scheduleStatus: scheduleResult.status,
        workoutSignupId: scheduleResult.workoutSignupId,
      });
      pushed++;
    }

    const outcome: WeekPushResult = {
      success: failed === 0 && schedulingFailed === 0 && deferred === 0,
      pushed,
      failed,
      schedulingFailed,
      deferred,
      skipped,
      results,
    };

    if (hasReportableFailure) {
      const failedDays = results
        .filter((r) => r.status === "failed" || r.scheduleStatus === "failed")
        .map((r) => `${r.dayName}: ${r.error ?? "unknown"}`)
        .join("; ");
      void ctx.runAction(internal.discord.notifyError, {
        source: "pushWeekPlan",
        message: `Week push: ${pushed} pushed, ${failed} push failures, ${schedulingFailed} scheduling failures. Failures: ${failedDays}`,
        userId,
      });
    }

    return outcome;
  },
});
