import { v } from "convex/values";
import { internalQuery, query } from "./_generated/server";
import { getEffectiveUserId } from "./lib/auth";
import { generatePerformanceSummary } from "./coach/prDetection";
import type { WorkoutPerformanceSummary } from "./coach/prDetection";
import type { PerMovementHistoryEntry } from "./progressiveOverload";
import { CACHE_TTLS } from "./tonal/cache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AllTimePREntry {
  movementId: string;
  movementName: string;
  bestWeightLbs: number;
  achievedDate: string;
  muscleGroups: string[];
  totalSessions: number;
}

export interface RecentPRSummary {
  recentPRs: Array<{
    movementId: string;
    movementName: string;
    newWeightLbs: number;
    previousBestLbs: number;
    improvementPct: number;
  }>;
  plateauCount: number;
  regressionCount: number;
  steadyCount: number;
  totalMovementsTracked: number;
}

/** Covers every recent-trend window used by `generatePerformanceSummary`. */
const RECENT_WINDOW_DAYS = 120;
export const WORKOUT_PERFORMANCE_ACTIVITY_LIMIT = 20;
const WORKOUT_PERFORMANCE_CANDIDATE_LIMIT = WORKOUT_PERFORMANCE_ACTIVITY_LIMIT + 1;
export const WORKOUT_PERFORMANCE_PER_ACTIVITY_ROW_LIMIT = 200;
export const WORKOUT_PERFORMANCE_PROJECTION_ROW_LIMIT = 1_000;
export const WORKOUT_PERFORMANCE_PROJECTION_MOVEMENT_LIMIT = 200;

export type WorkoutPerformanceProjectionResult =
  | { status: "ready"; summary: WorkoutPerformanceSummary }
  | { status: "miss" }
  | { status: "limit_exceeded" };

interface ProjectionWorkout {
  date: string;
  activityTime?: string;
}

function orderProjectionWorkouts<T extends ProjectionWorkout>(workouts: readonly T[]): T[] | null {
  const datesWithMultipleWorkouts = new Set<string>();
  for (let index = 1; index < workouts.length; index++) {
    if (workouts[index - 1].date === workouts[index].date) {
      datesWithMultipleWorkouts.add(workouts[index].date);
    }
  }
  if (
    workouts.some(
      (workout) =>
        datesWithMultipleWorkouts.has(workout.date) &&
        (workout.activityTime === undefined || !Number.isFinite(Date.parse(workout.activityTime))),
    )
  ) {
    return null;
  }
  return [...workouts].sort(
    (left, right) =>
      right.date.localeCompare(left.date) ||
      (right.activityTime === undefined ? 0 : Date.parse(right.activityTime)) -
        (left.activityTime === undefined ? 0 : Date.parse(left.activityTime)),
  );
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Minimal shape needed from an exercisePerformance row. */
export interface PerfRow {
  activityId: string;
  movementId: string;
  date: string;
  sets: number;
  totalReps: number;
  avgWeightLbs?: number;
}

/** Group performance rows into PerMovementHistoryEntry[] for prDetection. */
export function buildHistoryFromRows(rows: readonly PerfRow[]): PerMovementHistoryEntry[] {
  const sessionMap = new Map<
    string,
    Array<{
      sessionDate: string;
      sets: number;
      totalReps: number;
      repsPerSet: number;
      avgWeightLbs?: number;
    }>
  >();

  for (const row of rows) {
    const snapshot = {
      sessionDate: row.date,
      sets: row.sets,
      totalReps: row.totalReps,
      repsPerSet: row.sets > 0 ? Math.round(row.totalReps / row.sets) : 0,
      avgWeightLbs: row.avgWeightLbs ?? undefined,
    };
    const sessions = sessionMap.get(row.movementId);
    if (sessions) {
      sessions.push(snapshot);
    } else {
      sessionMap.set(row.movementId, [snapshot]);
    }
  }

  return Array.from(sessionMap, ([movementId, sessions]) => ({
    movementId,
    sessions,
  }));
}

/** Build RecentPRSummary from history + name map. */
export function buildRecentPRSummary(
  history: PerMovementHistoryEntry[],
  nameMap: ReadonlyMap<string, string>,
): RecentPRSummary {
  const summary = generatePerformanceSummary(history, nameMap);
  return {
    recentPRs: summary.prs,
    plateauCount: summary.plateaus.length,
    regressionCount: summary.regressions.length,
    steadyCount: summary.steadyProgressionCount,
    totalMovementsTracked: history.length,
  };
}

/** YYYY-MM-DD string for `daysAgo` days before `now`, in UTC. */
export function isoDateDaysAgo(now: Date, daysAgo: number): string {
  const cutoff = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

export const getWorkoutPerformanceProjection = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<WorkoutPerformanceProjectionResult> => {
    const candidates = await ctx.db
      .query("completedWorkouts")
      .withIndex("by_userId_date", (q) => q.eq("userId", userId))
      .order("desc")
      .take(WORKOUT_PERFORMANCE_CANDIDATE_LIMIT);

    const orderedCandidates = orderProjectionWorkouts(candidates);
    if (
      orderedCandidates === null ||
      (orderedCandidates.length > WORKOUT_PERFORMANCE_ACTIVITY_LIMIT &&
        orderedCandidates[WORKOUT_PERFORMANCE_ACTIVITY_LIMIT - 1].date ===
          orderedCandidates[WORKOUT_PERFORMANCE_ACTIVITY_LIMIT].date)
    ) {
      return { status: "miss" };
    }
    const workouts = orderedCandidates.slice(0, WORKOUT_PERFORMANCE_ACTIVITY_LIMIT);
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    const cacheAge = Date.now() - (profile?.workoutProjectionSourceFetchedAt ?? 0);

    if (
      workouts.length === 0 ||
      cacheAge < 0 ||
      cacheAge >= CACHE_TTLS.workoutHistory ||
      profile?.lastSyncedActivityDate !== workouts[0].date ||
      workouts.some((workout) => workout.performanceSyncComplete !== true)
    ) {
      return { status: "miss" };
    }

    const rowsByActivity = await Promise.all(
      workouts.map((workout) =>
        ctx.db
          .query("exercisePerformance")
          .withIndex("by_userId_activityId_movementId", (q) =>
            q.eq("userId", userId).eq("activityId", workout.activityId),
          )
          .take(WORKOUT_PERFORMANCE_PER_ACTIVITY_ROW_LIMIT + 1),
      ),
    );
    if (rowsByActivity.some((rows) => rows.length > WORKOUT_PERFORMANCE_PER_ACTIVITY_ROW_LIMIT)) {
      return { status: "limit_exceeded" };
    }

    const rows = rowsByActivity.flat();

    if (rows.length > WORKOUT_PERFORMANCE_PROJECTION_ROW_LIMIT) {
      return { status: "limit_exceeded" };
    }
    const weightedRows = rows.filter(
      (row) => row.avgWeightLbs !== undefined && row.avgWeightLbs > 0,
    );
    if (weightedRows.length === 0) return { status: "miss" };

    const movementIds = [...new Set(weightedRows.map((row) => row.movementId))];
    if (movementIds.length > WORKOUT_PERFORMANCE_PROJECTION_MOVEMENT_LIMIT) {
      return { status: "limit_exceeded" };
    }
    const movementDocs = await Promise.all(
      movementIds.map((movementId) =>
        ctx.db
          .query("movements")
          .withIndex("by_tonalId", (q) => q.eq("tonalId", movementId))
          .unique(),
      ),
    );
    const nameMap = new Map(
      movementDocs.flatMap((movement) =>
        movement === null ? [] : [[movement.tonalId, movement.name] as const],
      ),
    );

    return {
      status: "ready",
      summary: generatePerformanceSummary(buildHistoryFromRows(weightedRows), nameMap),
    };
  },
});

// ---------------------------------------------------------------------------
// getAllTimePRs — one indexed scan of the personalRecords projection.
// ---------------------------------------------------------------------------

export const getAllTimePRs = query({
  args: {},
  handler: async (ctx): Promise<AllTimePREntry[]> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const records = await ctx.db
      .query("personalRecords")
      .withIndex("by_userId_best", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    if (records.length === 0) return [];

    const movementDocs = await ctx.db.query("movements").collect();
    const metaMap = new Map(
      movementDocs.map((m) => [m.tonalId, { name: m.name, muscleGroups: m.muscleGroups }]),
    );

    return records.map((r) => {
      const meta = metaMap.get(r.movementId);
      return {
        movementId: r.movementId,
        movementName: meta?.name ?? "Unknown",
        bestWeightLbs: Math.round(r.bestAvgWeightLbs),
        achievedDate: r.achievedDate,
        muscleGroups: meta?.muscleGroups ?? [],
        totalSessions: r.totalSessions,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// getRecentPRSummary — recent PRs, plateaus, regressions via prDetection.
// ---------------------------------------------------------------------------

export const getRecentPRSummary = query({
  args: {},
  handler: async (ctx): Promise<RecentPRSummary> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const since = isoDateDaysAgo(new Date(), RECENT_WINDOW_DAYS);

    const [rows, movementDocs] = await Promise.all([
      ctx.db
        .query("exercisePerformance")
        .withIndex("by_userId_date", (q) => q.eq("userId", userId).gte("date", since))
        .order("desc")
        .collect(),
      ctx.db.query("movements").collect(),
    ]);

    const history = buildHistoryFromRows(rows);
    const nameMap = new Map(movementDocs.map((m) => [m.tonalId, m.name]));

    return buildRecentPRSummary(history, nameMap);
  },
});
