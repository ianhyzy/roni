/**
 * AI agent tools for weekly training programming.
 *
 * - getWeekPlanDetailsTool: retrieves current week plan with resolved exercise names
 * - deleteWeekPlanTool: deletes the current week plan and its draft workouts
 * - getWorkoutPerformanceTool: PR / plateau / volume summary for a movement
 * - createApproveWeekPlanTool: pushes all draft day workouts to Tonal
 *
 * programWeekTool lives in `./programWeekTool.ts` (split for file-size budget).
 */

import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { DAY_NAMES } from "../coach/weekProgrammingHelpers";
import type { WorkoutPerformanceSummary } from "../coach/prDetection";
import type { WeekPushResult } from "../coach/pushAndVerifyContract";
import type { Movement } from "../tonal/types";
import type { PushDivergence } from "../tonal/mutations";
import { getWeekStartDateStringInTimezone } from "../weekPlanHelpers";
import { requireUserId, withToolTracking } from "./helpers";
import { type DayDivergence, formatPushDivergenceNote } from "./divergenceNote";

// ---------------------------------------------------------------------------
// getWeekPlanDetailsTool
// ---------------------------------------------------------------------------

type WorkoutBlocks = {
  exercises?: { movementId?: string; sets?: number; reps?: number; duration?: number }[];
}[];

interface ExerciseDetail {
  movementId: string;
  name: string;
  muscleGroups: string[];
  sets: number;
  reps?: number;
  durationSeconds?: number;
}

function resolveExercises(
  blocks: WorkoutBlocks,
  movementMap: Map<string, Movement>,
): ExerciseDetail[] {
  const exercises: ExerciseDetail[] = [];
  for (const block of blocks) {
    for (const ex of block.exercises ?? []) {
      if (!ex.movementId) continue;
      const movement = movementMap.get(ex.movementId);
      const isDurationBased = movement ? !movement.countReps : false;
      exercises.push({
        movementId: ex.movementId,
        name: movement?.name ?? ex.movementId,
        muscleGroups: movement?.muscleGroups ?? [],
        sets: ex.sets ?? 3,
        ...(isDurationBased ? { durationSeconds: ex.duration ?? 30 } : { reps: ex.reps ?? 10 }),
      });
    }
  }
  return exercises;
}

interface WeekPlanDayDetail {
  dayIndex: number;
  dayName: string;
  sessionType: string;
  status: string;
  workoutStatus?: Doc<"workoutPlans">["status"];
  estimatedDuration?: number;
  exercises: {
    movementId: string;
    name: string;
    muscleGroups: string[];
    sets: number;
    reps?: number;
    durationSeconds?: number;
  }[];
}

interface WeekPlanDetails {
  weekStartDate: string;
  preferredSplit: string;
  targetDays: number;
  days: WeekPlanDayDetail[];
}

export function createGetWeekPlanDetailsTool(userTimezone?: string) {
  return createTool({
    description:
      "Retrieve the current week's training plan with resolved exercise details. Use when the user asks to see the plan or when the coach needs to inspect the existing draft before modifying it. Do not use to create, approve, delete, or analyze completed workout performance. Inputs are empty; returns the current week plan with calendar and linked-workout statuses, session type, estimated duration, movement IDs, exercise names, muscle groups, sets, reps, and duration seconds.",
    inputSchema: z.object({}),
    execute: withToolTracking(
      "get_week_plan_details",
      async (
        ctx,
        _input,
        _options,
      ): Promise<{ found: true; plan: WeekPlanDetails } | { found: false; message: string }> => {
        const userId = requireUserId(ctx);
        const weekStartDate = getWeekStartDateStringInTimezone(new Date(), userTimezone);

        const weekPlan = (await ctx.runQuery(internal.weekPlans.getByUserIdAndWeekStartInternal, {
          userId,
          weekStartDate,
        })) as {
          _id: Id<"weekPlans">;
          weekStartDate: string;
          preferredSplit: string;
          targetDays: number;
          days: {
            sessionType: string;
            status: string;
            workoutPlanId?: Id<"workoutPlans">;
            estimatedDuration?: number;
          }[];
        } | null;

        if (!weekPlan) {
          return { found: false, message: "No week plan found for the current week." };
        }

        // Load movement catalog for name resolution
        const catalog: Movement[] = await ctx.runQuery(internal.tonal.movementSync.getAllMovements);
        const movementMap = new Map(catalog.map((m) => [m.id, m]));

        // Resolve each day's workout details
        const dayDetails: WeekPlanDayDetail[] = [];

        for (let i = 0; i < weekPlan.days.length; i++) {
          const day = weekPlan.days[i];
          const detail: WeekPlanDayDetail = {
            dayIndex: i,
            dayName: DAY_NAMES[i],
            sessionType: day.sessionType,
            status: day.status,
            estimatedDuration: day.estimatedDuration,
            exercises: [],
          };

          if (day.workoutPlanId) {
            const workoutPlan = (await ctx.runQuery(internal.workoutPlans.getById, {
              planId: day.workoutPlanId,
              userId,
            })) as Pick<Doc<"workoutPlans">, "blocks" | "status"> | null;

            if (workoutPlan) {
              detail.workoutStatus = workoutPlan.status;
              detail.exercises = resolveExercises(workoutPlan.blocks, movementMap);
            }
          }

          dayDetails.push(detail);
        }

        return {
          found: true,
          plan: {
            weekStartDate: weekPlan.weekStartDate,
            preferredSplit: weekPlan.preferredSplit,
            targetDays: weekPlan.targetDays,
            days: dayDetails,
          },
        };
      },
    ),
  });
}

export const getWeekPlanDetailsTool = createGetWeekPlanDetailsTool();

// ---------------------------------------------------------------------------
// deleteWeekPlanTool
// ---------------------------------------------------------------------------

export function createDeleteWeekPlanTool(userTimezone?: string) {
  return createTool({
    description:
      "Delete the current week's training plan and all linked draft workouts. Use when the user wants to discard the current weekly draft or start the week over. Do not use to delete a standalone Tonal custom workout or to remove only one exercise from a draft day. Inputs are empty; returns deleted:true or a message when no current week plan exists.",
    inputSchema: z.object({}),
    needsApproval: true,
    execute: withToolTracking(
      "delete_week_plan",
      async (
        ctx,
        _input,
        _options,
      ): Promise<{ deleted: true } | { deleted: false; message: string }> => {
        const userId = requireUserId(ctx);
        const weekStartDate = getWeekStartDateStringInTimezone(new Date(), userTimezone);

        const weekPlan = (await ctx.runQuery(internal.weekPlans.getByUserIdAndWeekStartInternal, {
          userId,
          weekStartDate,
        })) as { _id: Id<"weekPlans"> } | null;

        if (!weekPlan) {
          return { deleted: false, message: "No week plan found for the current week." };
        }

        const deletion = (await ctx.runMutation(internal.weekPlans.deleteWeekPlanInternal, {
          userId,
          weekPlanId: weekPlan._id,
        })) as { ok: true; deleted: boolean } | { ok: false; error: string };

        if (!deletion.ok) return { deleted: false, message: deletion.error };
        if (!deletion.deleted) {
          return { deleted: false, message: "The week plan was already removed." };
        }
        return { deleted: true };
      },
    ),
  });
}

export const deleteWeekPlanTool = createDeleteWeekPlanTool();

// ---------------------------------------------------------------------------
// getWorkoutPerformanceTool
// ---------------------------------------------------------------------------

export const getWorkoutPerformanceTool = createTool({
  description:
    "Analyze per-movement performance trends across recent completed training. Use when the user asks about PRs, plateaus, regressions, progression, recent gains, or whether a lift is improving. Do not use to list individual workouts or inspect one workout's per-set details; use get_workout_history or get_workout_detail for those. Inputs are empty; returns a workout performance summary with movement-level trend signals.",
  inputSchema: z.object({}),
  execute: withToolTracking(
    "get_workout_performance",
    async (ctx, _input, _options): Promise<WorkoutPerformanceSummary> => {
      const userId = requireUserId(ctx);
      const result = (await ctx.runAction(
        internal.progressiveOverload.getWorkoutPerformanceSummary,
        { userId },
      )) as WorkoutPerformanceSummary;
      return result;
    },
  ),
});

// ---------------------------------------------------------------------------
// approveWeekPlanTool
// ---------------------------------------------------------------------------

export function createApproveWeekPlanTool(userTimezone?: string) {
  return createTool({
    description:
      "Push all draft workouts in the current week plan to Tonal. Use only after the user clearly approves the draft plan in chat, such as saying it looks good, send it, or push it. Do not use before a plan exists or while the user is still requesting changes. Inputs are empty; returns per-day push status and a divergence note if Tonal stores any workout differently than requested.",
    inputSchema: z.object({}),
    needsApproval: true,
    execute: withToolTracking(
      "approve_week_plan",
      async (
        ctx,
        _input,
        _options,
      ): Promise<(WeekPushResult & { divergenceNote?: string }) | { error: string }> => {
        const userId = requireUserId(ctx);
        const weekStartDate = getWeekStartDateStringInTimezone(new Date(), userTimezone);

        const plan = (await ctx.runQuery(internal.weekPlans.getByUserIdAndWeekStartInternal, {
          userId,
          weekStartDate,
        })) as { _id: Id<"weekPlans"> } | null;

        if (!plan) {
          return { error: "No week plan found. Use program_week first." };
        }

        const result = (await ctx.runAction(internal.coach.pushAndVerify.pushWeekPlanToTonal, {
          userId,
          weekPlanId: plan._id,
          ...(userTimezone ? { userTimezone } : {}),
        })) as WeekPushResult;

        // Aggregate per-day divergence and surface to LLM.
        const dayDivergences: DayDivergence[] = result.results
          .filter(
            (r): r is typeof r & { pushDivergence: PushDivergence } =>
              r.pushDivergence != null &&
              (r.pushDivergence.missingMovements.length > 0 ||
                r.pushDivergence.extraMovements.length > 0 ||
                r.pushDivergence.setCountMismatches.length > 0),
          )
          .map((r) => ({ dayName: r.dayName, divergence: r.pushDivergence }));

        const divergenceNote = formatPushDivergenceNote(dayDivergences);
        if (divergenceNote) {
          return { ...result, divergenceNote };
        }

        return result;
      },
    ),
  });
}
