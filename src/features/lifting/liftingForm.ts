import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";

export type LiftingSessionSummary = FunctionReturnType<typeof api.liftingSessions.listMine>[number];
export type LiftingSessionDetail = NonNullable<
  FunctionReturnType<typeof api.liftingSessions.getMine>
>;
export type LiftingSessionId = FunctionArgs<typeof api.liftingSessions.getMine>["sessionId"];
type LiftingSessionSaveInput = FunctionArgs<typeof api.liftingSessions.saveMine>["input"];

export type LiftingSetDraft = {
  readonly clientId: string;
  readonly kind: "warmup" | "working";
  readonly reps: string;
  readonly weightLbs: string;
  readonly rpe: string;
};

export type LiftingExerciseDraft = {
  readonly clientId: string;
  readonly name: string;
  readonly sets: readonly LiftingSetDraft[];
};

export type LiftingSessionDraft = {
  readonly title: string;
  readonly performedDate: string;
  readonly performedTime: string;
  readonly durationMinutes: string;
  readonly notes: string;
  readonly exercises: readonly LiftingExerciseDraft[];
};

export type LiftingSaveTarget =
  | { readonly kind: "create" }
  | {
      readonly kind: "replace";
      readonly sessionId: LiftingSessionId;
      readonly originalPerformedAt: number;
      readonly originalPerformedDate: string;
      readonly originalPerformedTime: string;
    };

export type LiftingSaveResult =
  | { readonly status: "valid"; readonly input: LiftingSessionSaveInput }
  | { readonly status: "invalid"; readonly message: string };

const MAX_EXERCISES = 20;
const MAX_SETS_PER_EXERCISE = 20;
const MAX_NAME_LENGTH = 100;
const MAX_NOTES_LENGTH = 1_000;
let nextDraftClientId = 0;

export function createEmptySetDraft(): LiftingSetDraft {
  return {
    clientId: createDraftClientId("set"),
    kind: "working",
    reps: "",
    weightLbs: "",
    rpe: "",
  };
}

export function createEmptyExerciseDraft(): LiftingExerciseDraft {
  return {
    clientId: createDraftClientId("exercise"),
    name: "",
    sets: [createEmptySetDraft()],
  };
}

export function createEmptyLiftingDraft(now = new Date()): LiftingSessionDraft {
  return {
    title: "",
    performedDate: formatLocalDate(now),
    performedTime: formatLocalTime(now),
    durationMinutes: "",
    notes: "",
    exercises: [createEmptyExerciseDraft()],
  };
}

export function createLiftingDraftFromDetail(detail: LiftingSessionDetail): LiftingSessionDraft {
  const performedAt = new Date(detail.performedAt);
  return {
    title: detail.title,
    performedDate: detail.calendarDate,
    performedTime: formatLocalTime(performedAt),
    durationMinutes: detail.durationMinutes?.toString() ?? "",
    notes: detail.notes ?? "",
    exercises: detail.exercises.map((exercise) => ({
      clientId: `exercise-${exercise.exerciseId}`,
      name: exercise.name,
      sets: exercise.sets.map((set) => ({
        clientId: `set-${set.setId}`,
        kind: set.kind,
        reps: set.reps.toString(),
        weightLbs: set.weightLbs?.toString() ?? "",
        rpe: set.rpe?.toString() ?? "",
      })),
    })),
  };
}

export function createLiftingReplaceTarget(
  detail: LiftingSessionDetail,
): Extract<LiftingSaveTarget, { readonly kind: "replace" }> {
  return {
    kind: "replace",
    sessionId: detail.sessionId,
    originalPerformedAt: detail.performedAt,
    originalPerformedDate: detail.calendarDate,
    originalPerformedTime: formatLocalTime(new Date(detail.performedAt)),
  };
}

export function buildLiftingSaveInput(
  draft: LiftingSessionDraft,
  target: LiftingSaveTarget,
): LiftingSaveResult {
  const title = draft.title.trim();
  if (title.length < 1 || title.length > MAX_NAME_LENGTH) {
    return invalid(`Title must be between 1 and ${MAX_NAME_LENGTH} characters.`);
  }

  const parsedPerformedAt = parseLocalDateTime(draft.performedDate, draft.performedTime);
  if (parsedPerformedAt === null) return invalid("Choose a valid performed date and time.");
  const performedAt =
    target.kind === "replace" &&
    draft.performedDate === target.originalPerformedDate &&
    draft.performedTime === target.originalPerformedTime
      ? target.originalPerformedAt
      : parsedPerformedAt;

  const duration = parseOptionalNumber(draft.durationMinutes);
  if (
    duration === null ||
    (duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 1_440))
  ) {
    return invalid("Duration must be a whole number from 1 to 1440 minutes.");
  }

  const notes = draft.notes.trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    return invalid(`Notes must be ${MAX_NOTES_LENGTH} characters or fewer.`);
  }
  if (draft.exercises.length < 1 || draft.exercises.length > MAX_EXERCISES) {
    return invalid(`Add between 1 and ${MAX_EXERCISES} exercises.`);
  }

  const exercises: LiftingSessionSaveInput["session"]["exercises"] = [];
  for (const [exerciseIndex, exercise] of draft.exercises.entries()) {
    const name = exercise.name.trim();
    if (name.length < 1 || name.length > MAX_NAME_LENGTH) {
      return invalid(
        `Exercise ${exerciseIndex + 1} name must be between 1 and ${MAX_NAME_LENGTH} characters.`,
      );
    }
    if (exercise.sets.length < 1 || exercise.sets.length > MAX_SETS_PER_EXERCISE) {
      return invalid(`Exercise ${exerciseIndex + 1} must have 1 to ${MAX_SETS_PER_EXERCISE} sets.`);
    }

    const sets: LiftingSessionSaveInput["session"]["exercises"][number]["sets"] = [];
    for (const [setIndex, set] of exercise.sets.entries()) {
      const setLabel = `Exercise ${exerciseIndex + 1}, set ${setIndex + 1}`;
      const reps = parseRequiredNumber(set.reps);
      if (reps === null || !Number.isInteger(reps) || reps < 1 || reps > 1_000) {
        return invalid(`${setLabel} reps must be a whole number from 1 to 1000.`);
      }

      const weightLbs = parseOptionalNumber(set.weightLbs);
      if (weightLbs === null || (weightLbs !== undefined && (weightLbs < 0 || weightLbs > 5_000))) {
        return invalid(`${setLabel} weight must be between 0 and 5000 lb.`);
      }

      const rpe = parseOptionalNumber(set.rpe);
      if (rpe === null || (rpe !== undefined && (rpe < 1 || rpe > 10))) {
        return invalid(`${setLabel} RPE must be between 1 and 10.`);
      }

      sets.push({
        kind: set.kind,
        reps,
        ...(weightLbs !== undefined ? { weightLbs } : {}),
        ...(rpe !== undefined ? { rpe } : {}),
      });
    }
    exercises.push({ name, sets });
  }

  const session: LiftingSessionSaveInput["session"] = {
    performedAt,
    calendarDate: draft.performedDate,
    title,
    ...(duration !== undefined ? { durationMinutes: duration } : {}),
    ...(notes ? { notes } : {}),
    exercises,
  };

  return target.kind === "create"
    ? { status: "valid", input: { kind: "create", session } }
    : {
        status: "valid",
        input: { kind: "replace", sessionId: target.sessionId, session },
      };
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatLocalTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function parseLocalDateTime(dateValue: string, timeValue: string): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!dateMatch || !timeMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  const parsed = new Date(year, month - 1, day, hours, minutes);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day ||
    parsed.getHours() !== hours ||
    parsed.getMinutes() !== minutes
  ) {
    return null;
  }
  return parsed.getTime() > 0 ? parsed.getTime() : null;
}

function parseRequiredNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseOptionalNumber(value: string): number | undefined | null {
  if (!value.trim()) return undefined;
  return parseRequiredNumber(value);
}

function invalid(message: string): LiftingSaveResult {
  return { status: "invalid", message };
}

function createDraftClientId(kind: "exercise" | "set"): string {
  nextDraftClientId += 1;
  return `${kind}-${nextDraftClientId}`;
}
