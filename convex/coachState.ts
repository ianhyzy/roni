import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { GARMIN_WELLNESS_SNAPSHOT_ROW_LIMIT } from "./ai/garminWellnessSnapshot";
import { FITBIT_WELLNESS_SNAPSHOT_ROW_LIMIT } from "./ai/fitbitWellnessSnapshot";
import { MAX_EXCLUDED_EXERCISES } from "./exerciseExclusions";
import { isDeletionInProgress } from "./lib/auth";
import { MAX_RECENT_WELLNESS_DAILY_ROWS } from "./garmin/wellnessDaily";
import { MAX_RECENT_FITBIT_WELLNESS_ROWS } from "./fitbit/wellnessDaily";
import { MAX_INJECTED_MEMORY_FACTS } from "./userMemoryFacts";

// Keep the aggregated snapshot query within the bounded per-source read limits.
const RECENT_COMPLETED_WORKOUTS_LIMIT = 20;
const RECENT_FEEDBACK_LIMIT = 5;
const RECENT_EXTERNAL_ACTIVITIES_LIMIT = 20;
// Avoid reading wellness rows the formatter will immediately discard.
const GARMIN_WELLNESS_LIMIT = Math.min(
  GARMIN_WELLNESS_SNAPSHOT_ROW_LIMIT,
  MAX_RECENT_WELLNESS_DAILY_ROWS,
);
const FITBIT_WELLNESS_LIMIT = Math.min(
  FITBIT_WELLNESS_SNAPSHOT_ROW_LIMIT,
  MAX_RECENT_FITBIT_WELLNESS_ROWS,
);

export interface SnapshotInputs {
  deletionInProgress?: boolean;
  profile: Doc<"userProfiles"> | null;
  scores: ReadonlyArray<Doc<"currentStrengthScores">>;
  readiness: Doc<"muscleReadiness"> | null;
  activities: ReadonlyArray<Doc<"completedWorkouts">>;
  activeBlock: Doc<"trainingBlocks"> | null;
  recentFeedback: ReadonlyArray<Doc<"workoutFeedback">>;
  activeGoals: ReadonlyArray<Doc<"goals">>;
  activeInjuries: ReadonlyArray<Doc<"injuries">>;
  exerciseExclusions: ReadonlyArray<Doc<"exerciseExclusions">>;
  externalActivities: ReadonlyArray<Doc<"externalActivities">>;
  garminWellness: ReadonlyArray<Doc<"garminWellnessDaily">>;
  fitbitWellness: ReadonlyArray<Doc<"fitbitWellnessDaily">>;
  memoryFacts?: ReadonlyArray<Doc<"userMemoryFacts">>;
}

/** Keep one failed snapshot source from poisoning the other reads. */
export async function safe<T>(read: () => Promise<T>, fallback: T, sourceName: string): Promise<T> {
  try {
    return await read();
  } catch (err) {
    console.error(`gatherSnapshotInputs: ${sourceName} read failed`, err);
    return fallback;
  }
}

/** Aggregate snapshot reads into one invocation while preserving per-source fallback. */
export const gatherSnapshotInputs = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<SnapshotInputs> => {
    if (await isDeletionInProgress(ctx, userId)) {
      return {
        deletionInProgress: true,
        profile: null,
        scores: [],
        readiness: null,
        activities: [],
        activeBlock: null,
        recentFeedback: [],
        activeGoals: [],
        activeInjuries: [],
        exerciseExclusions: [],
        externalActivities: [],
        garminWellness: [],
        fitbitWellness: [],
        memoryFacts: [],
      };
    }
    const profile = await safe(() => readUserProfile(ctx, userId), null, "profile");
    const fitbitConnection = await safe<Doc<"fitbitConnections"> | null>(
      () =>
        ctx.db
          .query("fitbitConnections")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .unique(),
      null,
      "fitbitConnection",
    );
    const activeFitbitGeneration =
      fitbitConnection?.status === "active" ? fitbitConnection.generation : null;

    const [
      scores,
      readiness,
      activities,
      activeBlock,
      recentFeedback,
      activeGoals,
      activeInjuries,
      exerciseExclusions,
      externalActivities,
      garminWellness,
      fitbitWellness,
      memoryFacts,
    ] = await Promise.all([
      safe<Doc<"currentStrengthScores">[]>(
        () =>
          ctx.db
            .query("currentStrengthScores")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .collect(),
        [],
        "scores",
      ),
      safe<Doc<"muscleReadiness"> | null>(
        () =>
          ctx.db
            .query("muscleReadiness")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .first(),
        null,
        "readiness",
      ),
      safe<Doc<"completedWorkouts">[]>(
        () => readRecentCompletedWorkouts(ctx, userId),
        [],
        "activities",
      ),
      safe<Doc<"trainingBlocks"> | null>(() => readActiveBlock(ctx, userId), null, "activeBlock"),
      safe<Doc<"workoutFeedback">[]>(
        () =>
          ctx.db
            .query("workoutFeedback")
            .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
            .order("desc")
            .take(RECENT_FEEDBACK_LIMIT),
        [],
        "recentFeedback",
      ),
      safe<Doc<"goals">[]>(
        () =>
          ctx.db
            .query("goals")
            .withIndex("by_userId_status", (q) => q.eq("userId", userId).eq("status", "active"))
            .collect(),
        [],
        "activeGoals",
      ),
      safe<Doc<"injuries">[]>(
        () =>
          ctx.db
            .query("injuries")
            .withIndex("by_userId_status", (q) => q.eq("userId", userId).eq("status", "active"))
            .collect(),
        [],
        "activeInjuries",
      ),
      safe<Doc<"exerciseExclusions">[]>(
        () => readExerciseExclusions(ctx, userId),
        [],
        "exerciseExclusions",
      ),
      safe<Doc<"externalActivities">[]>(
        () => readRecentExternalActivities(ctx, userId, activeFitbitGeneration),
        [],
        "externalActivities",
      ),
      safe<Doc<"garminWellnessDaily">[]>(
        () =>
          ctx.db
            .query("garminWellnessDaily")
            .withIndex("by_userId_calendarDate", (q) => q.eq("userId", userId))
            .order("desc")
            .take(GARMIN_WELLNESS_LIMIT),
        [],
        "garminWellness",
      ),
      safe<Doc<"fitbitWellnessDaily">[]>(
        () =>
          activeFitbitGeneration
            ? ctx.db
                .query("fitbitWellnessDaily")
                .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
                  q.eq("userId", userId).eq("generation", activeFitbitGeneration),
                )
                .order("desc")
                .take(FITBIT_WELLNESS_LIMIT)
            : Promise.resolve([]),
        [],
        "fitbitWellness",
      ),
      safe<Doc<"userMemoryFacts">[]>(
        () =>
          ctx.db
            .query("userMemoryFacts")
            .withIndex("by_userId_confidence_lastReferencedAt", (q) => q.eq("userId", userId))
            .order("desc")
            .take(MAX_INJECTED_MEMORY_FACTS),
        [],
        "memoryFacts",
      ),
    ]);

    return {
      deletionInProgress: false,
      profile,
      scores,
      readiness,
      activities,
      activeBlock,
      recentFeedback,
      activeGoals,
      activeInjuries,
      exerciseExclusions,
      externalActivities,
      garminWellness,
      fitbitWellness,
      memoryFacts,
    };
  },
});

async function readUserProfile(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Doc<"userProfiles"> | null> {
  return ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
}

async function readRecentCompletedWorkouts(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Doc<"completedWorkouts">[]> {
  // Mirror internal.tonal.syncQueries.getRecentCompletedWorkouts: over-read by
  // 3x then drop ghost entries (empty title) so the final list still hits the
  // requested count after filtering.
  const rows = await ctx.db
    .query("completedWorkouts")
    .withIndex("by_userId_date", (q) => q.eq("userId", userId))
    .order("desc")
    .take(RECENT_COMPLETED_WORKOUTS_LIMIT * 3);
  return rows.filter((r) => r.title !== "").slice(0, RECENT_COMPLETED_WORKOUTS_LIMIT);
}

async function readRecentExternalActivities(
  ctx: QueryCtx,
  userId: Id<"users">,
  activeFitbitGeneration: string | null,
): Promise<Doc<"externalActivities">[]> {
  const withoutDirectFitbit = ctx.db
    .query("externalActivities")
    .withIndex("by_userId_and_fitbitConnectionGeneration_and_beginTime", (q) =>
      q.eq("userId", userId).eq("fitbitConnectionGeneration", undefined),
    )
    .order("desc")
    .take(RECENT_EXTERNAL_ACTIVITIES_LIMIT);
  const currentDirectFitbit = activeFitbitGeneration
    ? ctx.db
        .query("externalActivities")
        .withIndex("by_userId_and_fitbitConnectionGeneration_and_beginTime", (q) =>
          q.eq("userId", userId).eq("fitbitConnectionGeneration", activeFitbitGeneration),
        )
        .order("desc")
        .take(RECENT_EXTERNAL_ACTIVITIES_LIMIT)
    : Promise.resolve([]);
  const rows = await Promise.all([withoutDirectFitbit, currentDirectFitbit]);
  return rows
    .flat()
    .sort(
      (left, right) =>
        right.beginTime.localeCompare(left.beginTime) || right._creationTime - left._creationTime,
    )
    .slice(0, RECENT_EXTERNAL_ACTIVITIES_LIMIT);
}

async function readActiveBlock(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Doc<"trainingBlocks"> | null> {
  const blocks = await ctx.db
    .query("trainingBlocks")
    .withIndex("by_userId_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .collect();
  return blocks[0] ?? null;
}

async function readExerciseExclusions(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Doc<"exerciseExclusions">[]> {
  return await ctx.db
    .query("exerciseExclusions")
    .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
    .order("desc")
    .take(MAX_EXCLUDED_EXERCISES);
}
