/**
 * AI agent tool for generating a draft week plan.
 *
 * Wraps `internal.coach.weekProgramming.generateDraftWeekPlan` and surfaces
 * any per-day degenerate exercise selection back to the LLM via reasoningHints.
 */

import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type {
  DraftDaySummary,
  DraftWeekSummary,
  ExerciseSummary,
} from "../coach/weekProgrammingHelpers";
import { getWeekStartDateString } from "../weekPlanHelpers";
import { requireUserId, withToolTracking } from "./helpers";
import { buildReasoningPrompt } from "./weekReasoning";

const ALLOWED_SESSION_DURATIONS = [30, 45, 60] as const;
type SessionDuration = (typeof ALLOWED_SESSION_DURATIONS)[number];

export type ProgramWeekToolExerciseSummary = Omit<ExerciseSummary, "movementId">;
export type ProgramWeekToolDaySummary = Omit<DraftDaySummary, "workoutPlanId" | "exercises"> & {
  exercises: ProgramWeekToolExerciseSummary[];
};
export type ProgramWeekToolSummary = Omit<DraftWeekSummary, "days"> & {
  days: ProgramWeekToolDaySummary[];
};

function validateSessionDuration(value: unknown): SessionDuration | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : undefined;
  if (Number.isInteger(parsed) && ALLOWED_SESSION_DURATIONS.includes(parsed as SessionDuration)) {
    return parsed as SessionDuration;
  }
  return undefined;
}

/** Keep the model-facing result limited to fields used for plan presentation. */
export function projectProgramWeekSummary(summary: DraftWeekSummary): ProgramWeekToolSummary {
  return {
    weekStartDate: summary.weekStartDate,
    preferredSplit: summary.preferredSplit,
    targetDays: summary.targetDays,
    sessionDurationMinutes: summary.sessionDurationMinutes,
    days: summary.days.map((day) => ({
      dayIndex: day.dayIndex,
      dayName: day.dayName,
      sessionType: day.sessionType,
      estimatedDuration: day.estimatedDuration,
      exercises: day.exercises.map((exercise) => ({
        name: exercise.name,
        muscleGroups: exercise.muscleGroups,
        sets: exercise.sets,
        ...(exercise.reps === undefined ? {} : { reps: exercise.reps }),
        ...(exercise.durationSeconds === undefined
          ? {}
          : { durationSeconds: exercise.durationSeconds }),
        ...(exercise.lastTime === undefined ? {} : { lastTime: exercise.lastTime }),
        ...(exercise.suggestedTarget === undefined
          ? {}
          : { suggestedTarget: exercise.suggestedTarget }),
        ...(exercise.lastWeight === undefined ? {} : { lastWeight: exercise.lastWeight }),
        ...(exercise.targetWeight === undefined ? {} : { targetWeight: exercise.targetWeight }),
      })),
    })),
  };
}

export const programWeekTool = createTool({
  description: `Program the user's full training week by creating draft workouts for each training day. Use when the user asks for a weekly plan, a new training week, or a full split such as Push/Pull/Legs, Upper/Lower, Full Body, or Bro Split. Do not use for one standalone workout, a single-day draft rewrite, a 1:1 exercise swap, or pushing an already-created plan. Inputs may provide preferredSplit, trainingDays, targetDays, and sessionDurationMinutes, or omit them to use saved preferences; returns a draft week summary, weekPlanId, reasoningHints, and any restriction warnings.

IMPORTANT: The backend algorithm selects the exact exercises, sets, and reps. The coach should call this tool, then faithfully describe what it returned in the \`summary\` field. Never pre-announce specific exercises before calling this tool (e.g. "I'll program bench press, rows, and squats..."), because the algorithm may pick differently based on user history, muscle readiness, injuries, and progressive overload. Never describe exercise names, sets, or reps that are not present in the returned \`summary\`.

Duration-based movements in the summary use a duration (seconds) instead of reps. Describe them in seconds (e.g. "30s hold") — never as "4x10".

The plan is NOT pushed to Tonal yet. Present it to the user for approval first, then use approve_week_plan.`,
  inputSchema: z.object({
    preferredSplit: z
      .enum(["ppl", "upper_lower", "full_body", "bro_split"])
      .optional()
      .describe(
        "Training split. ppl = Push/Pull/Legs, upper_lower = Upper/Lower, full_body = Full Body, bro_split = Bodybuilding body-part split (Chest/Back/Shoulders/Arms/Legs). Omit to use saved preferences.",
      ),
    trainingDays: z
      .array(z.number().int().min(0).max(6))
      .optional()
      .describe(
        "Day indices: 0=Monday, 1=Tuesday, ..., 6=Sunday. Omit to auto-space based on count.",
      ),
    targetDays: z
      .number()
      .int()
      .min(1)
      .max(7)
      .optional()
      .describe("Number of training days per week (used if trainingDays is omitted)."),
    sessionDurationMinutes: z
      .enum(["30", "45", "60"])
      .optional()
      .describe("Session duration. Omit to use saved preferences."),
  }),
  inputExamples: [
    { input: {} },
    {
      input: {
        preferredSplit: "upper_lower",
        trainingDays: [0, 2, 4, 5],
        sessionDurationMinutes: "45",
      },
    },
    {
      input: {
        preferredSplit: "ppl",
        targetDays: 3,
        sessionDurationMinutes: "60",
      },
    },
  ],
  execute: withToolTracking(
    "program_week",
    async (
      ctx,
      input,
      _options,
    ): Promise<
      | {
          success: true;
          weekPlanId: string;
          summary: ProgramWeekToolSummary;
          reasoningHints: string;
          degenerateDays?: {
            dayIndex: number;
            dayName: string;
            eliminatedByInjury: number;
            eliminatedByMovementId: number;
            eliminatedByAccessory: number;
          }[];
        }
      | { success: false; error: string }
    > => {
      const userId = requireUserId(ctx);

      // Load saved preferences as defaults
      const saved = (await ctx.runQuery(internal.userProfiles.getTrainingPreferencesInternal, {
        userId,
      })) as {
        preferredSplit?: "ppl" | "upper_lower" | "full_body" | "bro_split";
        trainingDays?: number[];
        sessionDurationMinutes?: number;
      } | null;

      const preferredSplit = input.preferredSplit ?? saved?.preferredSplit ?? "ppl";
      const inputDuration = validateSessionDuration(input.sessionDurationMinutes);
      const savedDuration = validateSessionDuration(saved?.sessionDurationMinutes);
      const sessionDuration = inputDuration ?? savedDuration ?? 45;

      const targetDays =
        input.trainingDays?.length ?? input.targetDays ?? saved?.trainingDays?.length ?? 3;

      const result = (await ctx.runAction(internal.coach.weekProgramming.generateDraftWeekPlan, {
        userId,
        weekStartDate: getWeekStartDateString(new Date()),
        preferredSplit,
        targetDays,
        sessionDurationMinutes: sessionDuration,
        trainingDayIndicesOverride: input.trainingDays ?? saved?.trainingDays,
      })) as
        | {
            success: true;
            weekPlanId: Id<"weekPlans">;
            summary: DraftWeekSummary;
            degenerateDays: {
              dayIndex: number;
              dayName: string;
              eliminatedByInjury: number;
              eliminatedByMovementId: number;
              eliminatedByAccessory: number;
            }[];
          }
        | { success: false; error: string };

      if (!result.success) return result;

      // Build lightweight reasoning hints from data already in scope.
      // The AI agent has the full training snapshot (muscle readiness,
      // injuries, feedback) in its context — no need to duplicate here.
      const reasoningHints = buildReasoningPrompt({
        split: preferredSplit,
        targetDays,
        sessionDuration,
        muscleReadiness: {},
        recentWorkouts: [],
        activeInjuries: [],
        recentFeedback: null,
        isDeload: false,
      });

      const degenerateNote =
        result.degenerateDays.length > 0
          ? `\n\nWARNING: ${result.degenerateDays.length} day(s) had to be programmed with a heavily-restricted exercise pool because of injury, exercise exclusion, or equipment filters. Affected days: ${result.degenerateDays.map((d) => d.dayName).join(", ")}. The plan may feel monotonous. Consider asking the user to relax their restrictions or use search_exercises to find alternative compound movements.`
          : "";

      return {
        ...result,
        summary: projectProgramWeekSummary(result.summary),
        reasoningHints: reasoningHints + degenerateNote,
      };
    },
  ),
});
