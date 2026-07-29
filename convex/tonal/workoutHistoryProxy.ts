/**
 * Workout history fetch actions.
 * - fetchWorkoutHistory: recent 200 (for incremental sync)
 * - fetchWorkoutHistoryPage: single page at offset (for backfill)
 * - fetchWorkoutHistoryForEligibility: last 100 (for activation checks)
 */

import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { fetchRecentWorkoutActivities, fetchWorkoutActivitiesPage, tonalFetch } from "./client";
import { retryOn5xx } from "./mutations";
import { CACHE_TTLS, WORKOUT_HISTORY_CACHE_TYPE } from "./cache";
import { cachedFetch, cachedFetchWithMetadata, fetchWorkoutMetaBatch, toActivity } from "./proxy";
import { TonalSessionExpiredError, withTokenRetry } from "./tokenRetry";
import type { Activity, WorkoutActivityDetail } from "./types";
import type { WorkoutMeta } from "./workoutMeta";

const GHOST_WORKOUT_ID = "00000000-0000-0000-0000-000000000000";
const WORKOUT_HISTORY_PAGE_LIMIT = 200;

interface ActivityPreviewMeta extends WorkoutMeta {
  activityId: string;
  workoutId: string;
}

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function projectActivityPreviewMeta(activity: Activity): ActivityPreviewMeta {
  const preview = activity.workoutPreview;
  const meta: ActivityPreviewMeta = {
    activityId: activity.activityId,
    workoutId: preview.workoutId,
  };
  const title = optionalString(preview.workoutTitle);
  const targetArea = optionalString(preview.targetArea);
  const programName = optionalString(preview.programName);
  if (title) meta.title = title;
  if (targetArea) meta.targetArea = targetArea;
  if (programName) meta.programName = programName;
  return meta;
}

function mergeWorkoutMeta(
  workoutMeta: WorkoutMeta | undefined,
  activityMeta: WorkoutMeta | undefined,
): WorkoutMeta | undefined {
  // The precedence is asymmetric: workoutMeta from /v6/workouts/{id} has the
  // better title/targetArea, while activityMeta from legacy /activities is the
  // authoritative source for programName.
  if (!workoutMeta) return activityMeta;
  if (!activityMeta) return workoutMeta;
  return {
    title: workoutMeta.title ?? activityMeta.title,
    targetArea: workoutMeta.targetArea ?? activityMeta.targetArea,
    programName: activityMeta.programName ?? workoutMeta.programName,
  };
}

async function fetchActivityPreviewMeta(
  ctx: ActionCtx,
  userId: Id<"users">,
  token: string,
  tonalUserId: string,
  offset: number,
  limit: number,
): Promise<Map<string, ActivityPreviewMeta>> {
  try {
    const previews = await cachedFetch<ActivityPreviewMeta[]>(ctx, {
      userId,
      dataType: `activityPreviewMeta:${offset}:${limit}`,
      ttl: CACHE_TTLS.workoutHistory,
      fetcher: async () => {
        const activities = await tonalFetch<Activity[]>(
          token,
          `/v6/users/${tonalUserId}/activities?offset=${offset}&limit=${limit}`,
        );
        return activities.map(projectActivityPreviewMeta);
      },
    });
    return new Map(previews.map((preview) => [preview.activityId, preview]));
  } catch (error) {
    console.warn("[workoutHistory] activity preview metadata unavailable", error);
    return new Map();
  }
}

async function enrichWorkoutActivities(
  ctx: ActionCtx,
  userId: Id<"users">,
  token: string,
  tonalUserId: string,
  items: WorkoutActivityDetail[],
  previewOffset: number,
  previewLimit: number,
): Promise<Activity[]> {
  const real = items.filter(
    (wa) => wa.workoutId !== GHOST_WORKOUT_ID || wa.totalVolume > 0 || wa.totalConcentricWork > 0,
  );
  if (real.length === 0) return [];
  const ids = [...new Set(real.map((w) => w.workoutId))];
  const [workoutMeta, activityMeta] = await Promise.all([
    fetchWorkoutMetaBatch(ctx, token, ids),
    fetchActivityPreviewMeta(ctx, userId, token, tonalUserId, previewOffset, previewLimit),
  ]);
  return real.map((wa) =>
    toActivity(wa, mergeWorkoutMeta(workoutMeta.get(wa.workoutId), activityMeta.get(wa.id))),
  );
}

export interface WorkoutHistorySnapshot {
  activities: Activity[];
  sourceFetchedAt?: number;
}

async function fetchRecentHistorySnapshot(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<WorkoutHistorySnapshot> {
  try {
    return await withTokenRetry(ctx, userId, async (token, tonalUserId) => {
      const snapshot = await cachedFetchWithMetadata<Activity[]>(ctx, {
        userId,
        dataType: WORKOUT_HISTORY_CACHE_TYPE,
        ttl: CACHE_TTLS.workoutHistory,
        fetcher: async () => {
          const items = await fetchRecentWorkoutActivities<WorkoutActivityDetail>(
            token,
            tonalUserId,
            WORKOUT_HISTORY_PAGE_LIMIT,
          );
          return enrichWorkoutActivities(
            ctx,
            userId,
            token,
            tonalUserId,
            items,
            0,
            WORKOUT_HISTORY_PAGE_LIMIT,
          );
        },
      });
      return { activities: snapshot.data, sourceFetchedAt: snapshot.fetchedAt };
    });
  } catch (e) {
    if (e instanceof TonalSessionExpiredError) return { activities: [] };
    throw e;
  }
}

/** Fetch recent workout history plus the timestamp of that exact source snapshot. */
export const fetchWorkoutHistorySnapshot = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<WorkoutHistorySnapshot> =>
    fetchRecentHistorySnapshot(ctx, userId),
});

/** Fetch recent workout history (newest 200). Used by incremental sync. */
export const fetchWorkoutHistory = internalAction({
  args: { userId: v.id("users"), limit: v.optional(v.number()) },
  handler: async (ctx, { userId, limit }): Promise<Activity[]> => {
    const snapshot = await fetchRecentHistorySnapshot(ctx, userId);
    return limit === undefined ? snapshot.activities : snapshot.activities.slice(0, limit);
  },
});

/** Fetch one page of workout history at the given offset. Used by backfill to
 *  avoid loading all 1000+ workouts into one action's 64MB memory limit. */
interface PageResult {
  activities: Activity[];
  pageSize: number;
  pgTotal: number;
  sourceFetchedAt: number;
}

/** Fetch one page of workout history at the given offset. Cached by userId+offset
 *  so backfill batching (20 items/invocation from a 200-item page) doesn't re-fetch.
 *
 *  Unlike fetchWorkoutHistory, session expiry is NOT swallowed here: backfill runs
 *  once at connect time and must fail loudly rather than break the loop with pgTotal=0
 *  and silently mark syncStatus "complete" with no data. */
export const fetchWorkoutHistoryPage = internalAction({
  args: { userId: v.id("users"), offset: v.number() },
  handler: async (ctx, { userId, offset }): Promise<PageResult> =>
    withTokenRetry(ctx, userId, async (token, tonalUserId) => {
      const snapshot = await cachedFetchWithMetadata<Omit<PageResult, "sourceFetchedAt">>(ctx, {
        userId,
        dataType: `workoutPage_v2:${offset}`,
        ttl: CACHE_TTLS.workoutHistory,
        fetcher: async () => {
          const { items, pgTotal } = await fetchWorkoutActivitiesPage<WorkoutActivityDetail>(
            token,
            tonalUserId,
            offset,
            WORKOUT_HISTORY_PAGE_LIMIT,
          );
          const activities = await enrichWorkoutActivities(
            ctx,
            userId,
            token,
            tonalUserId,
            items,
            offset,
            WORKOUT_HISTORY_PAGE_LIMIT,
          );
          return { activities, pageSize: items.length, pgTotal };
        },
      });
      return { ...snapshot.data, sourceFetchedAt: snapshot.fetchedAt };
    }),
});

/** Activities for activation eligibility check (separate cache key from fetchWorkoutHistory). */
export const fetchWorkoutHistoryForEligibility = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<Activity[]> => {
    try {
      return await withTokenRetry(ctx, userId, (token, tonalUserId) =>
        cachedFetch<Activity[]>(ctx, {
          userId,
          dataType: "workoutHistoryEligibility",
          ttl: 5 * 60 * 1000,
          fetcher: () =>
            retryOn5xx(() =>
              tonalFetch<Activity[]>(token, `/v6/users/${tonalUserId}/activities?limit=100`),
            ),
        }),
      );
    } catch (e) {
      if (e instanceof TonalSessionExpiredError) return [];
      throw e;
    }
  },
});
