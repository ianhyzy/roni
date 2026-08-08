import { z } from "zod";

export const weekPlanPresentationSchema = z.object({
  weekStartDate: z.string(),
  split: z.enum(["ppl", "upper_lower", "full_body", "bro_split"]),
  days: z.array(
    z.object({
      dayName: z.string(),
      sessionType: z.string(),
      targetMuscles: z.string(),
      durationMinutes: z.number(),
      exercises: z.array(
        z.object({
          name: z.string(),
          sets: z.number(),
          reps: z.number().optional(),
          duration: z.number().optional(),
          targetWeight: z.number().optional(),
          lastWeight: z.number().optional(),
          lastReps: z.number().optional(),
          note: z.string().optional(),
          accessory: z.string().optional(),
          block: z.number().optional(),
        }),
      ),
    }),
  ),
  summary: z.string(),
});

const PROGRAM_WEEK_DAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

const PROGRAM_WEEK_SESSION_TYPES = [
  "push",
  "pull",
  "legs",
  "upper",
  "lower",
  "full_body",
  "chest",
  "back",
  "shoulders",
  "arms",
] as const;

const programWeekDurationSchema = z.union([z.literal(30), z.literal(45), z.literal(60)]);

const programWeekDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Invalid calendar date");

const programWeekExerciseSchema = z
  .object({
    name: z.string().min(1),
    muscleGroups: z.array(z.string()),
    sets: z.number().int().positive(),
    reps: z.number().int().positive().optional(),
    durationSeconds: z.number().int().positive().optional(),
    // Older stored tool messages used `duration` before `durationSeconds` was introduced.
    duration: z.number().int().positive().optional(),
    targetWeight: z.number().nonnegative().optional(),
    lastWeight: z.number().nonnegative().optional(),
    suggestedTarget: z.string().optional(),
    lastTime: z.string().optional(),
  })
  .superRefine((exercise, ctx) => {
    const hasReps = exercise.reps !== undefined;
    const durationFieldCount =
      Number(exercise.durationSeconds !== undefined) + Number(exercise.duration !== undefined);
    const hasDuration = durationFieldCount > 0;

    if (Number(hasReps) + Number(hasDuration) !== 1 || durationFieldCount > 1) {
      ctx.addIssue({
        code: "custom",
        message: "Exercise must use exactly one reps or duration mode",
      });
    }
  });

const programWeekDaySchema = z
  .object({
    dayIndex: z.number().int().min(0).max(6).optional(),
    dayName: z.enum(PROGRAM_WEEK_DAY_NAMES),
    sessionType: z.enum(PROGRAM_WEEK_SESSION_TYPES),
    estimatedDuration: programWeekDurationSchema,
    exercises: z.array(programWeekExerciseSchema),
  })
  .superRefine((day, ctx) => {
    if (day.dayIndex !== undefined && PROGRAM_WEEK_DAY_NAMES[day.dayIndex] !== day.dayName) {
      ctx.addIssue({ code: "custom", message: "dayIndex and dayName must match" });
    }
  });

export const programWeekSummarySchema = z.object({
  weekStartDate: programWeekDateSchema,
  preferredSplit: weekPlanPresentationSchema.shape.split,
  targetDays: z.number().int().min(1).max(7).optional(),
  sessionDurationMinutes: programWeekDurationSchema.optional(),
  days: z.array(programWeekDaySchema).min(1),
});

export const programWeekOutputSchema = z.object({
  success: z.literal(true),
  summary: programWeekSummarySchema,
});

/**
 * Shape of `get_week_plan_details`' successful output. Deliberately separate
 * from programWeekSummarySchema: this tool reads back whatever is stored, so
 * sessionType is a free string and estimatedDuration may be absent, where the
 * program_week summary is generated and can promise the strict enums.
 */
const weekPlanDetailsExerciseSchema = z.object({
  movementId: z.string(),
  name: z.string(),
  muscleGroups: z.array(z.string()),
  sets: z.number(),
  reps: z.number().optional(),
  durationSeconds: z.number().optional(),
});

const weekPlanDetailsDaySchema = z.object({
  dayIndex: z.number().int().min(0).max(6),
  dayName: z.string(),
  sessionType: z.string(),
  status: z.string(),
  workoutStatus: z
    .enum(["draft", "pushing", "pushed", "completed", "deleted", "failed"])
    .optional(),
  estimatedDuration: z.number().optional(),
  exercises: z.array(weekPlanDetailsExerciseSchema),
});

export const weekPlanDetailsOutputSchema = z.object({
  found: z.literal(true),
  plan: z.object({
    weekStartDate: z.string(),
    preferredSplit: z.string(),
    targetDays: z.number(),
    days: z.array(weekPlanDetailsDaySchema),
  }),
});

export type WeekPlanPresentation = z.infer<typeof weekPlanPresentationSchema>;
