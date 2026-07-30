/**
 * Week plan helpers: constants, validators, and date utilities.
 * Pure functions with no Convex DB operations. Imported by all other weekPlan files.
 */

import { v } from "convex/values";

/** Session type for a day in the week plan. */
export const SESSION_TYPES = [
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
  "recovery",
  "rest",
] as const;

/** Day status for calendar display. */
export const DAY_STATUSES = ["programmed", "completed", "missed", "rescheduled"] as const;

export const NON_DRAFT_WORKOUT_EDIT_ERROR =
  "Only draft workouts can be edited. Pushed or completed workouts stay on their Tonal Calendar date.";

/** Serialize the exact draft snapshot approved for a Tonal push. */
export function getWorkoutApprovalFingerprint(workout: { title: string; blocks: unknown }): string {
  return JSON.stringify([workout.title, workout.blocks]);
}

export type DraftWorkoutMutationBlocker = "non_draft" | "scheduled" | "claimed";

/** Classify why a linked workout is unsafe to mutate or unlink. */
export function getDraftWorkoutMutationBlocker(workout: {
  status: string;
  tonalWorkoutSignupId?: string;
  tonalScheduledDate?: string;
  tonalSchedulingReceiptVerifiedAt?: number;
  tonalSchedulingClaim?: unknown;
}): DraftWorkoutMutationBlocker | null {
  if (workout.status !== "draft") return "non_draft";
  if (
    workout.tonalWorkoutSignupId !== undefined ||
    workout.tonalScheduledDate !== undefined ||
    workout.tonalSchedulingReceiptVerifiedAt !== undefined
  ) {
    return "scheduled";
  }
  if (workout.tonalSchedulingClaim !== undefined) return "claimed";
  return null;
}

export const sessionTypeValidator = v.union(
  v.literal("push"),
  v.literal("pull"),
  v.literal("legs"),
  v.literal("upper"),
  v.literal("lower"),
  v.literal("full_body"),
  v.literal("chest"),
  v.literal("back"),
  v.literal("shoulders"),
  v.literal("arms"),
  v.literal("recovery"),
  v.literal("rest"),
);

export const dayStatusValidator = v.union(
  v.literal("programmed"),
  v.literal("completed"),
  v.literal("missed"),
  v.literal("rescheduled"),
);

export const daySlotValidator = v.object({
  sessionType: sessionTypeValidator,
  status: dayStatusValidator,
  workoutPlanId: v.optional(v.id("workoutPlans")),
  estimatedDuration: v.optional(v.number()),
});

/** Preferred split (exported for week programming action). */
export const preferredSplitValidator = v.union(
  v.literal("ppl"),
  v.literal("upper_lower"),
  v.literal("full_body"),
  v.literal("bro_split"),
);

export const DEFAULT_DAYS = [
  { sessionType: "rest" as const, status: "programmed" as const },
  { sessionType: "rest" as const, status: "programmed" as const },
  { sessionType: "rest" as const, status: "programmed" as const },
  { sessionType: "rest" as const, status: "programmed" as const },
  { sessionType: "rest" as const, status: "programmed" as const },
  { sessionType: "rest" as const, status: "programmed" as const },
  { sessionType: "rest" as const, status: "programmed" as const },
];

const WEEK_START_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Validates YYYY-MM-DD and that the date is parseable. */
export function isValidWeekStartDateString(s: string): boolean {
  if (!WEEK_START_DATE_REGEX.test(s)) return false;
  const d = new Date(s + "T12:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Returns the Monday of the week containing the given date as YYYY-MM-DD.
 * Used to get "current week" for the calendar and for unique week plan lookup.
 */
export function getWeekStartDateString(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dayOfMonth}`;
}

/** Returns YYYY-MM-DD for the instant in the user's local calendar. */
export function getDateStringInTimezone(date: Date, timeZone: string | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Invalid or unavailable timezones use the UTC calendar date.
  }
  return date.toISOString().slice(0, 10);
}

/** Returns the Monday containing the user's local calendar date. */
export function getWeekStartDateStringInTimezone(date: Date, timeZone: string | undefined): string {
  const calendarDate = getDateStringInTimezone(date, timeZone);
  return getWeekStartDateString(new Date(`${calendarDate}T00:00:00.000Z`));
}
