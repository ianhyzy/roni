import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { isDeletionInProgress } from "../lib/auth";
import { EXTERNAL_ACTIVITY_SOURCES } from "../tonal/externalActivitySources";
import { externalActivityValidator } from "../tonal/historySyncMutations";
import { FITBIT_READ_SCOPES } from "./config";

const MAX_DIRECT_FITBIT_ACTIVITIES = 500;
const MAX_FITBIT_DEDUPLICATION_CANDIDATES = 1000;
const WORKOUT_MATCH_TIME_TOLERANCE_MS = 1000;
const WORKOUT_MATCH_DURATION_TOLERANCE_SECONDS = 60;
const CIVIL_DATE_UTC_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const GOOGLE_HEALTH_EXTERNAL_ID_PREFIX = "google-health:";
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SCOPE_CLEANUP_BATCH_SIZE = 50;

function representsSameWorkout(
  directStart: number,
  directDuration: number,
  tonal: { start: number; totalDuration: number },
): boolean {
  return (
    Number.isFinite(directStart) &&
    Number.isFinite(tonal.start) &&
    Math.abs(directStart - tonal.start) <= WORKOUT_MATCH_TIME_TOLERANCE_MS &&
    Math.abs(directDuration - tonal.totalDuration) <= WORKOUT_MATCH_DURATION_TOLERANCE_SECONDS
  );
}

export const reconcileExternalActivities = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    startDate: v.string(),
    now: v.number(),
    activities: v.array(externalActivityValidator),
  },
  handler: async (ctx, { userId, generation, startDate, now, activities }) => {
    if (await isDeletionInProgress(ctx, userId)) return false;
    if (!CALENDAR_DATE_PATTERN.test(startDate)) {
      throw new Error("Invalid Fitbit activity reconciliation date");
    }
    const startDateUtc = Date.parse(`${startDate}T00:00:00.000Z`);
    if (!Number.isFinite(startDateUtc)) {
      throw new Error("Invalid Fitbit activity reconciliation date");
    }
    if (activities.length > MAX_DIRECT_FITBIT_ACTIVITIES) {
      throw new Error("Fitbit activity batch exceeds the bounded sync window");
    }
    const connection = await ctx.db
      .query("fitbitConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!connection || connection.status !== "active" || connection.generation !== generation) {
      return false;
    }

    const incoming = new Map(activities.map((activity) => [activity.externalId, activity]));
    for (const activity of incoming.values()) {
      if (
        activity.source !== EXTERNAL_ACTIVITY_SOURCES.FITBIT ||
        !activity.externalId.startsWith(GOOGLE_HEALTH_EXTERNAL_ID_PREFIX)
      ) {
        throw new Error("Invalid direct Fitbit activity payload");
      }
    }
    const fitbitRows = await ctx.db
      .query("externalActivities")
      .withIndex("by_userId_source_beginTime", (q) =>
        q
          .eq("userId", userId)
          .eq("source", EXTERNAL_ACTIVITY_SOURCES.FITBIT)
          .gte("beginTime", new Date(startDateUtc - CIVIL_DATE_UTC_LOOKBACK_MS).toISOString())
          .lte("beginTime", new Date(now).toISOString()),
      )
      .order("desc")
      .take(MAX_FITBIT_DEDUPLICATION_CANDIDATES + 1);
    if (fitbitRows.length > MAX_FITBIT_DEDUPLICATION_CANDIDATES) {
      throw new Error("Stored Fitbit deduplication set exceeds the bounded sync window");
    }
    const tonalFitbitRows = fitbitRows
      .filter((row) => row.fitbitConnectionGeneration === undefined)
      .map((row) => ({ start: Date.parse(row.beginTime), totalDuration: row.totalDuration }));
    for (const [externalId, activity] of incoming) {
      const directStart = Date.parse(activity.beginTime);
      if (
        tonalFitbitRows.some((row) =>
          representsSameWorkout(directStart, activity.totalDuration, row),
        )
      ) {
        incoming.delete(externalId);
      }
    }

    const existing = await ctx.db
      .query("externalActivities")
      .withIndex("by_userId_and_fitbitConnectionGeneration_and_externalId", (q) =>
        q.eq("userId", userId).eq("fitbitConnectionGeneration", generation),
      )
      .take(MAX_DIRECT_FITBIT_ACTIVITIES + 1);
    if (existing.length > MAX_DIRECT_FITBIT_ACTIVITIES) {
      throw new Error("Stored Fitbit activity set exceeds the bounded sync window");
    }
    const existingById = new Map(existing.map((row) => [row.externalId, row]));
    for (const activity of incoming.values()) {
      const row = existingById.get(activity.externalId);
      if (row && row.syncedAt > now) continue;
      const next = {
        userId,
        ...activity,
        fitbitConnectionGeneration: generation,
        syncedAt: now,
      };
      if (row) await ctx.db.replace(row._id, next);
      else await ctx.db.insert("externalActivities", next);
    }
    for (const row of existing) {
      if (!incoming.has(row.externalId) && row.syncedAt <= now) await ctx.db.delete(row._id);
    }
    return true;
  },
});

export const purgeRevokedActivityScope = internalMutation({
  args: { userId: v.id("users"), generation: v.string() },
  handler: async (ctx, { userId, generation }) => {
    const connection = await ctx.db
      .query("fitbitConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (
      !connection ||
      connection.status !== "active" ||
      connection.generation !== generation ||
      connection.scopes.includes(FITBIT_READ_SCOPES[0])
    ) {
      return false;
    }

    const rows = await ctx.db
      .query("externalActivities")
      .withIndex("by_userId_and_fitbitConnectionGeneration_and_externalId", (q) =>
        q.eq("userId", userId).eq("fitbitConnectionGeneration", generation),
      )
      .take(SCOPE_CLEANUP_BATCH_SIZE);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === SCOPE_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.fitbit.activityPersistence.purgeRevokedActivityScope,
        { userId, generation },
      );
    }
    return true;
  },
});
