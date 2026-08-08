import {
  programWeekOutputSchema,
  weekPlanDetailsOutputSchema,
  type WeekPlanPresentation,
  weekPlanPresentationSchema,
} from "../../../convex/ai/schemas";

/**
 * Tools whose output renders as a full week-plan card instead of a status chip.
 *
 * get_week_plan_details is here because every draft-modification tool tells the
 * coach to call it after editing ("Use get_week_plan_details to see the updated
 * plan"). Without it the card could only ever appear on the one turn that ran
 * program_week, leaving the user staring at a stale snapshot of the plan while
 * later edits were invisible.
 */
export const WEEK_PLAN_CARD_TOOL_NAMES = ["program_week", "get_week_plan_details"] as const;

export type WeekPlanCardToolName = (typeof WEEK_PLAN_CARD_TOOL_NAMES)[number];

export function isWeekPlanCardToolName(toolName: string): toolName is WeekPlanCardToolName {
  return WEEK_PLAN_CARD_TOOL_NAMES.some((name) => name === toolName);
}

function uniqueMuscles(exercises: readonly { muscleGroups: string[] }[]): string {
  return [...new Set(exercises.flatMap((exercise) => exercise.muscleGroups))].join(", ");
}

function fromProgramWeek(output: unknown): WeekPlanPresentation | null {
  const parsed = programWeekOutputSchema.safeParse(output);
  if (!parsed.success) return null;

  const { summary } = parsed.data;
  const plan = weekPlanPresentationSchema.safeParse({
    weekStartDate: summary.weekStartDate,
    split: summary.preferredSplit,
    days: summary.days.map((day) => ({
      dayName: day.dayName,
      sessionType: day.sessionType,
      targetMuscles: uniqueMuscles(day.exercises),
      durationMinutes: day.estimatedDuration,
      exercises: day.exercises.map((exercise) => ({
        name: exercise.name,
        sets: exercise.sets,
        reps: exercise.reps,
        duration: exercise.durationSeconds ?? exercise.duration,
        targetWeight: exercise.targetWeight,
        lastWeight: exercise.lastWeight,
        note:
          [exercise.suggestedTarget, exercise.lastTime].filter(Boolean).join(" | ") || undefined,
      })),
    })),
    summary: `${summary.preferredSplit.toUpperCase()} split - ${summary.days.length} training days`,
  });

  return plan.success ? plan.data : null;
}

const DEFAULT_SESSION_MINUTES = 30;

function fromWeekPlanDetails(output: unknown): WeekPlanPresentation | null {
  const parsed = weekPlanDetailsOutputSchema.safeParse(output);
  if (!parsed.success) return null;

  const { plan } = parsed.data;
  // Rest days come back with an empty exercise list; the card shows training days.
  const trainingDays = plan.days.filter((day) => day.exercises.length > 0);
  if (trainingDays.length === 0) return null;

  const hasCompleteWorkoutStatus = trainingDays.every((day) => day.workoutStatus !== undefined);
  const pushedCount = trainingDays.filter(
    (day) => day.workoutStatus === "pushed" || day.workoutStatus === "completed",
  ).length;
  const statusNote = !hasCompleteWorkoutStatus
    ? undefined
    : pushedCount === trainingDays.length
      ? "pushed to Tonal"
      : pushedCount > 0
        ? `${pushedCount} of ${trainingDays.length} pushed to Tonal`
        : trainingDays.every((day) => day.workoutStatus === "draft")
          ? "draft - not pushed yet"
          : "not fully pushed to Tonal";

  const presentation = weekPlanPresentationSchema.safeParse({
    weekStartDate: plan.weekStartDate,
    split: plan.preferredSplit,
    days: trainingDays.map((day) => ({
      dayName: day.dayName,
      sessionType: day.sessionType,
      targetMuscles: uniqueMuscles(day.exercises),
      durationMinutes: day.estimatedDuration ?? DEFAULT_SESSION_MINUTES,
      exercises: day.exercises.map((exercise) => ({
        name: exercise.name,
        sets: exercise.sets,
        reps: exercise.reps,
        duration: exercise.durationSeconds,
      })),
    })),
    summary: [
      `${plan.preferredSplit.toUpperCase()} split - ${trainingDays.length} training days`,
      statusNote,
    ]
      .filter(Boolean)
      .join(" - "),
  });

  return presentation.success ? presentation.data : null;
}

/**
 * Map a card-rendering tool's output to card props, or null when the output
 * isn't a renderable plan (a failed call, or no plan for this week).
 */
export function toWeekPlanPresentation(
  toolName: WeekPlanCardToolName,
  output: unknown,
): WeekPlanPresentation | null {
  return toolName === "program_week" ? fromProgramWeek(output) : fromWeekPlanDetails(output);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** True when program_week reported an outright failure rather than a bad payload. */
export function isFailedProgramWeekOutput(output: unknown): boolean {
  return isRecord(output) && output.success === false;
}
