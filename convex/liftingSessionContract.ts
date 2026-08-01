import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";

export const DEFAULT_LIST_LIMIT = 10;
export const MAX_LIST_LIMIT = 50;
export const MAX_EXERCISES = 20;
export const MAX_SETS_PER_EXERCISE = 20;
export const MAX_TOTAL_SETS = MAX_EXERCISES * MAX_SETS_PER_EXERCISE;
const MAX_NAME_LENGTH = 100;
const MAX_NOTES_LENGTH = 1_000;

const liftingSetInputValidator = v.object({
  kind: v.union(v.literal("warmup"), v.literal("working")),
  reps: v.number(),
  weightLbs: v.optional(v.number()),
  rpe: v.optional(v.number()),
});

const liftingExerciseInputValidator = v.object({
  name: v.string(),
  sets: v.array(liftingSetInputValidator),
});

export const liftingSessionInputValidator = v.object({
  performedAt: v.number(),
  calendarDate: v.string(),
  title: v.string(),
  durationMinutes: v.optional(v.number()),
  notes: v.optional(v.string()),
  exercises: v.array(liftingExerciseInputValidator),
});

export const liftingSessionSummaryValidator = v.object({
  sessionId: v.id("liftingSessions"),
  source: v.literal("manual"),
  performedAt: v.number(),
  calendarDate: v.string(),
  title: v.string(),
  durationMinutes: v.union(v.number(), v.null()),
  notes: v.union(v.string(), v.null()),
  exerciseCount: v.number(),
  setCount: v.number(),
  totalReps: v.number(),
  totalVolumeLbs: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const liftingSetViewValidator = v.object({
  setId: v.id("liftingSets"),
  order: v.number(),
  kind: v.union(v.literal("warmup"), v.literal("working")),
  reps: v.number(),
  weightLbs: v.union(v.number(), v.null()),
  rpe: v.union(v.number(), v.null()),
});

const liftingExerciseViewValidator = v.object({
  exerciseId: v.id("liftingExercises"),
  order: v.number(),
  name: v.string(),
  setCount: v.number(),
  totalReps: v.number(),
  totalVolumeLbs: v.number(),
  sets: v.array(liftingSetViewValidator),
});

export const liftingSessionDetailValidator = v.object({
  ...liftingSessionSummaryValidator.fields,
  exercises: v.array(liftingExerciseViewValidator),
});

type LiftingSetInput = {
  readonly kind: "warmup" | "working";
  readonly reps: number;
  readonly weightLbs?: number;
  readonly rpe?: number;
};

type LiftingExerciseInput = {
  readonly name: string;
  readonly sets: readonly LiftingSetInput[];
};

type LiftingSessionInput = {
  readonly performedAt: number;
  readonly calendarDate: string;
  readonly title: string;
  readonly durationMinutes?: number;
  readonly notes?: string;
  readonly exercises: readonly LiftingExerciseInput[];
};

type NormalizedSet = LiftingSetInput;

export type NormalizedExercise = {
  readonly name: string;
  readonly sets: readonly NormalizedSet[];
  readonly setCount: number;
  readonly totalReps: number;
  readonly totalVolumeLbs: number;
};

export type NormalizedSession = {
  readonly performedAt: number;
  readonly calendarDate: string;
  readonly title: string;
  readonly durationMinutes?: number;
  readonly notes?: string;
  readonly exercises: readonly NormalizedExercise[];
  readonly exerciseCount: number;
  readonly setCount: number;
  readonly totalReps: number;
  readonly totalVolumeLbs: number;
};

export type LiftingSessionSummary = {
  readonly sessionId: Id<"liftingSessions">;
  readonly source: "manual";
  readonly performedAt: number;
  readonly calendarDate: string;
  readonly title: string;
  readonly durationMinutes: number | null;
  readonly notes: string | null;
  readonly exerciseCount: number;
  readonly setCount: number;
  readonly totalReps: number;
  readonly totalVolumeLbs: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type LiftingSetView = {
  readonly setId: Id<"liftingSets">;
  readonly order: number;
  readonly kind: "warmup" | "working";
  readonly reps: number;
  readonly weightLbs: number | null;
  readonly rpe: number | null;
};

function assertValidCalendarDate(calendarDate: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDate);
  if (!match) throw new Error("calendarDate must be a valid YYYY-MM-DD date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("calendarDate must be a valid YYYY-MM-DD date");
  }
}

function normalizeName(value: string, field: "title" | "exercise name"): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > MAX_NAME_LENGTH) {
    throw new Error(`${field} must be between 1 and ${MAX_NAME_LENGTH} characters`);
  }
  return normalized;
}

function normalizeSet(input: LiftingSetInput): NormalizedSet {
  if (!Number.isInteger(input.reps) || input.reps < 1 || input.reps > 1_000) {
    throw new Error("reps must be an integer from 1 to 1000");
  }
  if (
    input.weightLbs !== undefined &&
    (!Number.isFinite(input.weightLbs) || input.weightLbs < 0 || input.weightLbs > 5_000)
  ) {
    throw new Error("weightLbs must be between 0 and 5000");
  }
  if (input.rpe !== undefined && (!Number.isFinite(input.rpe) || input.rpe < 1 || input.rpe > 10)) {
    throw new Error("rpe must be between 1 and 10");
  }
  return {
    kind: input.kind,
    reps: input.reps,
    ...(input.weightLbs !== undefined ? { weightLbs: input.weightLbs } : {}),
    ...(input.rpe !== undefined ? { rpe: input.rpe } : {}),
  };
}

export function normalizeSession(input: LiftingSessionInput): NormalizedSession {
  if (
    !Number.isSafeInteger(input.performedAt) ||
    input.performedAt <= 0 ||
    Number.isNaN(new Date(input.performedAt).getTime())
  ) {
    throw new Error("performedAt must be a valid timestamp");
  }
  assertValidCalendarDate(input.calendarDate);
  const title = normalizeName(input.title, "title");
  if (
    input.durationMinutes !== undefined &&
    (!Number.isInteger(input.durationMinutes) ||
      input.durationMinutes < 1 ||
      input.durationMinutes > 1_440)
  ) {
    throw new Error("durationMinutes must be an integer from 1 to 1440");
  }
  const notes = input.notes?.trim();
  if (notes && notes.length > MAX_NOTES_LENGTH) {
    throw new Error(`notes must be ${MAX_NOTES_LENGTH} characters or fewer`);
  }
  if (input.exercises.length < 1 || input.exercises.length > MAX_EXERCISES) {
    throw new Error(`exercises must contain between 1 and ${MAX_EXERCISES} items`);
  }

  const exercises = input.exercises.map((exercise): NormalizedExercise => {
    const name = normalizeName(exercise.name, "exercise name");
    if (exercise.sets.length < 1 || exercise.sets.length > MAX_SETS_PER_EXERCISE) {
      throw new Error(`sets must contain between 1 and ${MAX_SETS_PER_EXERCISE} items`);
    }
    const sets = exercise.sets.map(normalizeSet);
    return {
      name,
      sets,
      setCount: sets.length,
      totalReps: sets.reduce((sum, set) => sum + set.reps, 0),
      totalVolumeLbs: sets.reduce((sum, set) => sum + set.reps * (set.weightLbs ?? 0), 0),
    };
  });

  return {
    performedAt: input.performedAt,
    calendarDate: input.calendarDate,
    title,
    ...(input.durationMinutes !== undefined ? { durationMinutes: input.durationMinutes } : {}),
    ...(notes ? { notes } : {}),
    exercises,
    exerciseCount: exercises.length,
    setCount: exercises.reduce((sum, exercise) => sum + exercise.setCount, 0),
    totalReps: exercises.reduce((sum, exercise) => sum + exercise.totalReps, 0),
    totalVolumeLbs: exercises.reduce((sum, exercise) => sum + exercise.totalVolumeLbs, 0),
  };
}

export function toLiftingSessionSummary(row: Doc<"liftingSessions">): LiftingSessionSummary {
  return {
    sessionId: row._id,
    source: row.source,
    performedAt: row.performedAt,
    calendarDate: row.calendarDate,
    title: row.title,
    durationMinutes: row.durationMinutes ?? null,
    notes: row.notes ?? null,
    exerciseCount: row.exerciseCount,
    setCount: row.setCount,
    totalReps: row.totalReps,
    totalVolumeLbs: row.totalVolumeLbs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
