import { v } from "convex/values";
import type { PushDivergence } from "../tonal/mutations";

type ScheduleStatus = "scheduled" | "already_scheduled" | "skipped_past" | "failed";

export interface PushResult {
  dayIndex: number;
  dayName: string;
  sessionType: string;
  status: "pushed" | "failed" | "skipped" | "deferred";
  title?: string;
  tonalWorkoutId?: string;
  error?: string;
  exerciseCount?: number;
  pushDivergence?: PushDivergence | null;
  scheduledDate?: string;
  scheduleStatus?: ScheduleStatus;
  workoutSignupId?: string;
  retryable?: boolean;
}

export interface WeekPushResult {
  success: boolean;
  pushed: number;
  failed: number;
  schedulingFailed: number;
  deferred: number;
  skipped: number;
  results: PushResult[];
}

const pushDivergenceValidator = v.object({
  missingMovements: v.array(v.string()),
  extraMovements: v.array(v.string()),
  setCountMismatches: v.array(
    v.object({ movementId: v.string(), intended: v.number(), stored: v.number() }),
  ),
});

const pushResultValidator = v.object({
  dayIndex: v.number(),
  dayName: v.string(),
  sessionType: v.string(),
  status: v.union(
    v.literal("pushed"),
    v.literal("failed"),
    v.literal("skipped"),
    v.literal("deferred"),
  ),
  title: v.optional(v.string()),
  tonalWorkoutId: v.optional(v.string()),
  error: v.optional(v.string()),
  exerciseCount: v.optional(v.number()),
  pushDivergence: v.optional(v.union(pushDivergenceValidator, v.null())),
  scheduledDate: v.optional(v.string()),
  scheduleStatus: v.optional(
    v.union(
      v.literal("scheduled"),
      v.literal("already_scheduled"),
      v.literal("skipped_past"),
      v.literal("failed"),
    ),
  ),
  workoutSignupId: v.optional(v.string()),
  retryable: v.optional(v.boolean()),
});

export const weekPushResultValidator = v.object({
  success: v.boolean(),
  pushed: v.number(),
  failed: v.number(),
  schedulingFailed: v.number(),
  deferred: v.number(),
  skipped: v.number(),
  results: v.array(pushResultValidator),
});
