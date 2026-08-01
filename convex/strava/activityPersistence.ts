import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { isDeletionInProgress } from "../lib/auth";
import { EXTERNAL_ACTIVITY_SOURCES } from "../tonal/externalActivitySources";

const PURGE_BATCH_SIZE = 50;
const UPSERT_BATCH_SIZE = 100;
const STRAVA_EXTERNAL_ID_PREFIX = "strava:";

const stravaActivitySummaryValidator = v.object({
  providerActivityId: v.string(),
  athleteId: v.string(),
  type: v.string(),
  sportType: v.string(),
  name: v.string(),
  startDate: v.string(),
  startDateLocal: v.string(),
  timezone: v.string(),
  distanceMeters: v.number(),
  movingTimeSeconds: v.number(),
  elapsedTimeSeconds: v.number(),
  elevationGainMeters: v.number(),
  achievementCount: v.number(),
  trainer: v.boolean(),
  commute: v.boolean(),
  manual: v.boolean(),
  private: v.literal(false),
});

type ActiveConnection = Extract<Doc<"stravaConnections">, { status: "active" }>;

async function getMatchingActiveConnection(
  ctx: MutationCtx,
  args: { userId: Doc<"stravaConnections">["userId"]; athleteId: string; generation: string },
): Promise<ActiveConnection | null> {
  if (await isDeletionInProgress(ctx, args.userId)) return null;
  const connection = await ctx.db
    .query("stravaConnections")
    .withIndex("by_userId", (q) => q.eq("userId", args.userId))
    .unique();
  if (
    !connection ||
    connection.status !== "active" ||
    connection.athleteId !== args.athleteId ||
    connection.generation !== args.generation
  ) {
    return null;
  }
  return connection;
}

function requireFiniteNonnegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid Strava activity ${field}`);
  }
}

function toExternalActivity(
  activity: typeof stravaActivitySummaryValidator.type,
): Omit<
  Doc<"externalActivities">,
  "_id" | "_creationTime" | "userId" | "syncedAt" | "stravaConnectionGeneration"
> {
  if (!activity.providerActivityId.trim() || !activity.sportType.trim()) {
    throw new Error("Invalid Strava activity identity");
  }
  if (!Number.isFinite(Date.parse(activity.startDate))) {
    throw new Error("Invalid Strava activity start date");
  }
  requireFiniteNonnegative(activity.distanceMeters, "distance");
  requireFiniteNonnegative(activity.movingTimeSeconds, "moving time");
  requireFiniteNonnegative(activity.elapsedTimeSeconds, "elapsed time");
  requireFiniteNonnegative(activity.elevationGainMeters, "elevation gain");

  const distance = activity.distanceMeters > 0 ? activity.distanceMeters : undefined;
  const avgPaceSecondsPerKm =
    distance && activity.movingTimeSeconds > 0
      ? activity.movingTimeSeconds / (distance / 1_000)
      : undefined;
  return {
    externalId: `${STRAVA_EXTERNAL_ID_PREFIX}${activity.providerActivityId}`,
    workoutType: activity.sportType,
    beginTime: activity.startDate,
    totalDuration: activity.elapsedTimeSeconds,
    source: EXTERNAL_ACTIVITY_SOURCES.STRAVA,
    distance,
    elevationGainMeters:
      activity.elevationGainMeters > 0 ? activity.elevationGainMeters : undefined,
    avgPaceSecondsPerKm,
  };
}

export const upsertActivity = internalMutation({
  args: {
    userId: v.id("users"),
    athleteId: v.string(),
    generation: v.string(),
    activity: stravaActivitySummaryValidator,
    now: v.number(),
  },
  returns: v.union(v.literal("upserted"), v.literal("ignored")),
  handler: async (ctx, args) => {
    if (args.activity.athleteId !== args.athleteId) return "ignored";
    if (!(await getMatchingActiveConnection(ctx, args))) return "ignored";
    const projected = {
      ...toExternalActivity(args.activity),
      stravaConnectionGeneration: args.generation,
    };
    const rows = await ctx.db
      .query("externalActivities")
      .withIndex("by_userId_and_stravaConnectionGeneration_and_externalId", (q) =>
        q
          .eq("userId", args.userId)
          .eq("stravaConnectionGeneration", args.generation)
          .eq("externalId", projected.externalId),
      )
      .take(2);
    if (rows.length > 1) throw new Error("Duplicate Strava activity rows");
    const next = { userId: args.userId, ...projected, syncedAt: args.now };
    const existing = rows[0];
    if (existing) {
      if (existing.syncedAt > args.now) return "ignored";
      await ctx.db.replace(existing._id, next);
    } else {
      await ctx.db.insert("externalActivities", next);
    }
    return "upserted";
  },
});

export const upsertActivityBatch = internalMutation({
  args: {
    userId: v.id("users"),
    athleteId: v.string(),
    generation: v.string(),
    activities: v.array(stravaActivitySummaryValidator),
    now: v.number(),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) => {
    if (args.activities.length > UPSERT_BATCH_SIZE) {
      throw new Error("Strava activity batch exceeds the page limit");
    }
    if (args.activities.some((activity) => activity.athleteId !== args.athleteId)) {
      throw new Error("Strava activity owner mismatch");
    }
    if (!(await getMatchingActiveConnection(ctx, args))) return null;
    const projected = args.activities.map((activity) => ({
      ...toExternalActivity(activity),
      stravaConnectionGeneration: args.generation,
    }));
    let upserted = 0;
    for (const activity of projected) {
      const rows = await ctx.db
        .query("externalActivities")
        .withIndex("by_userId_and_stravaConnectionGeneration_and_externalId", (q) =>
          q
            .eq("userId", args.userId)
            .eq("stravaConnectionGeneration", args.generation)
            .eq("externalId", activity.externalId),
        )
        .take(2);
      if (rows.length > 1) throw new Error("Duplicate Strava activity rows");
      const existing = rows[0];
      if (existing?.syncedAt && existing.syncedAt > args.now) continue;
      const next = { userId: args.userId, ...activity, syncedAt: args.now };
      if (existing) await ctx.db.replace(existing._id, next);
      else await ctx.db.insert("externalActivities", next);
      upserted += 1;
    }
    return upserted;
  },
});

export const deleteActivity = internalMutation({
  args: {
    userId: v.id("users"),
    athleteId: v.string(),
    generation: v.string(),
    providerActivityId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await getMatchingActiveConnection(ctx, args))) return false;
    const row = await ctx.db
      .query("externalActivities")
      .withIndex("by_userId_and_stravaConnectionGeneration_and_externalId", (q) =>
        q
          .eq("userId", args.userId)
          .eq("stravaConnectionGeneration", args.generation)
          .eq("externalId", `${STRAVA_EXTERNAL_ID_PREFIX}${args.providerActivityId}`),
      )
      .unique();
    if (!row) return false;
    await ctx.db.delete(row._id);
    return true;
  },
});

export const purgeGeneration = internalMutation({
  args: { userId: v.id("users"), generation: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("externalActivities")
      .withIndex("by_userId_and_stravaConnectionGeneration_and_externalId", (q) =>
        q.eq("userId", args.userId).eq("stravaConnectionGeneration", args.generation),
      )
      .take(PURGE_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === PURGE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.strava.activityPersistence.purgeGeneration, args);
    }
    return rows.length;
  },
});
