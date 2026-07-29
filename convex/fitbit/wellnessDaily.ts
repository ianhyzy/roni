import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { isDeletionInProgress } from "../lib/auth";
import { FITBIT_READ_SCOPES } from "./config";

export const MAX_RECENT_FITBIT_WELLNESS_ROWS = 30;
const MAX_STALE_WELLNESS_ROWS = 500;
const SCOPE_CLEANUP_BATCH_SIZE = 50;
const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const wellnessDataTypeValidator = v.union(
  v.literal("sleep"),
  v.literal("daily-resting-heart-rate"),
  v.literal("daily-heart-rate-variability"),
);
type WellnessDataType = "sleep" | "daily-resting-heart-rate" | "daily-heart-rate-variability";

type FitbitWellnessFields = Partial<
  Omit<
    Doc<"fitbitWellnessDaily">,
    "_creationTime" | "_id" | "userId" | "generation" | "calendarDate" | "lastIngestedAt"
  >
>;

const fieldsValidator = v.object({
  sleepDurationSeconds: v.optional(v.number()),
  deepSleepSeconds: v.optional(v.number()),
  lightSleepSeconds: v.optional(v.number()),
  remSleepSeconds: v.optional(v.number()),
  awakeSeconds: v.optional(v.number()),
  sleepStartTime: v.optional(v.string()),
  sleepEndTime: v.optional(v.string()),
  restingHeartRate: v.optional(v.number()),
  averageHrvMilliseconds: v.optional(v.number()),
});

export function compactFitbitWellnessFields(fields: FitbitWellnessFields): FitbitWellnessFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as FitbitWellnessFields;
}

function fieldsFromRow(row: Doc<"fitbitWellnessDaily">): FitbitWellnessFields {
  return compactFitbitWellnessFields({
    sleepDurationSeconds: row.sleepDurationSeconds,
    deepSleepSeconds: row.deepSleepSeconds,
    lightSleepSeconds: row.lightSleepSeconds,
    remSleepSeconds: row.remSleepSeconds,
    awakeSeconds: row.awakeSeconds,
    sleepStartTime: row.sleepStartTime,
    sleepEndTime: row.sleepEndTime,
    restingHeartRate: row.restingHeartRate,
    averageHrvMilliseconds: row.averageHrvMilliseconds,
  });
}

function clearSyncedFields(
  fields: FitbitWellnessFields,
  syncedDataTypes: readonly WellnessDataType[],
): FitbitWellnessFields {
  const next = { ...fields };
  if (syncedDataTypes.includes("sleep")) {
    delete next.sleepDurationSeconds;
    delete next.deepSleepSeconds;
    delete next.lightSleepSeconds;
    delete next.remSleepSeconds;
    delete next.awakeSeconds;
    delete next.sleepStartTime;
    delete next.sleepEndTime;
  }
  if (syncedDataTypes.includes("daily-resting-heart-rate")) delete next.restingHeartRate;
  if (syncedDataTypes.includes("daily-heart-rate-variability")) {
    delete next.averageHrvMilliseconds;
  }
  return next;
}

function isCalendarDate(value: string): boolean {
  return CALENDAR_DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export const upsertWellnessDaily = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    startDate: v.string(),
    syncedDataTypes: v.array(wellnessDataTypeValidator),
    now: v.number(),
    entries: v.array(v.object({ calendarDate: v.string(), fields: fieldsValidator })),
  },
  handler: async (ctx, { userId, generation, startDate, syncedDataTypes, now, entries }) => {
    if (await isDeletionInProgress(ctx, userId)) return false;
    if (!isCalendarDate(startDate)) throw new Error("Invalid Fitbit wellness start date");
    const connection = await ctx.db
      .query("fitbitConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!connection || connection.status !== "active" || connection.generation !== generation) {
      return false;
    }

    const entriesByDate = new Map<string, FitbitWellnessFields>();
    for (const entry of entries) {
      if (!isCalendarDate(entry.calendarDate)) throw new Error("Invalid Fitbit wellness date");
      if (entry.calendarDate < startDate) continue;
      entriesByDate.set(entry.calendarDate, {
        ...entriesByDate.get(entry.calendarDate),
        ...compactFitbitWellnessFields(entry.fields),
      });
    }
    if (entriesByDate.size > MAX_RECENT_FITBIT_WELLNESS_ROWS) {
      throw new Error("Fitbit wellness batch exceeds the 30-day window");
    }

    const currentRows = await ctx.db
      .query("fitbitWellnessDaily")
      .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
        q.eq("userId", userId).eq("generation", generation).gte("calendarDate", startDate),
      )
      .take(MAX_STALE_WELLNESS_ROWS + 1);
    if (currentRows.length > MAX_STALE_WELLNESS_ROWS) {
      throw new Error("Stored Fitbit wellness set exceeds the bounded sync window");
    }
    const currentByDate = new Map(currentRows.map((row) => [row.calendarDate, row]));
    const dates = new Set([...currentByDate.keys(), ...entriesByDate.keys()]);

    for (const calendarDate of dates) {
      const current = currentByDate.get(calendarDate);
      if (current && current.lastIngestedAt > now) continue;
      const incoming = entriesByDate.get(calendarDate) ?? {};
      const fields = {
        ...clearSyncedFields(current ? fieldsFromRow(current) : {}, syncedDataTypes),
        ...incoming,
      };
      if (Object.keys(fields).length === 0) {
        if (current) await ctx.db.delete(current._id);
        continue;
      }
      let existing = current;
      if (!existing) {
        const sameDateRows = await ctx.db
          .query("fitbitWellnessDaily")
          .withIndex("by_userId_and_calendarDate", (q) =>
            q.eq("userId", userId).eq("calendarDate", calendarDate),
          )
          .take(MAX_STALE_WELLNESS_ROWS + 1);
        if (sameDateRows.length > MAX_STALE_WELLNESS_ROWS) {
          throw new Error("Stored Fitbit wellness date has too many prior-generation rows");
        }
        existing = sameDateRows[0];
        for (const duplicate of sameDateRows.slice(1)) await ctx.db.delete(duplicate._id);
      }
      const next = { userId, generation, calendarDate, ...fields, lastIngestedAt: now };
      if (existing) await ctx.db.replace(existing._id, next);
      else await ctx.db.insert("fitbitWellnessDaily", next);
    }

    const staleRows = await ctx.db
      .query("fitbitWellnessDaily")
      .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
        q.eq("userId", userId).eq("generation", generation).lt("calendarDate", startDate),
      )
      .take(MAX_STALE_WELLNESS_ROWS);
    for (const staleRow of staleRows) await ctx.db.delete(staleRow._id);
    return true;
  },
});

export const purgeRevokedWellnessScope = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    scope: v.union(v.literal(FITBIT_READ_SCOPES[1]), v.literal(FITBIT_READ_SCOPES[2])),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { userId, generation, scope, cursor }) => {
    const connection = await ctx.db
      .query("fitbitConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (
      !connection ||
      connection.status !== "active" ||
      connection.generation !== generation ||
      connection.scopes.includes(scope)
    ) {
      return false;
    }

    const syncedDataTypes: readonly WellnessDataType[] =
      scope === FITBIT_READ_SCOPES[2]
        ? ["sleep"]
        : ["daily-resting-heart-rate", "daily-heart-rate-variability"];
    const page = await ctx.db
      .query("fitbitWellnessDaily")
      .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
        q.eq("userId", userId).eq("generation", generation),
      )
      .paginate({ cursor: cursor ?? null, numItems: SCOPE_CLEANUP_BATCH_SIZE });
    for (const row of page.page) {
      const fields = clearSyncedFields(fieldsFromRow(row), syncedDataTypes);
      if (Object.keys(fields).length === 0) {
        await ctx.db.delete(row._id);
      } else {
        await ctx.db.replace(row._id, {
          userId,
          generation,
          calendarDate: row.calendarDate,
          ...fields,
          lastIngestedAt: row.lastIngestedAt,
        });
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.fitbit.wellnessDaily.purgeRevokedWellnessScope, {
        userId,
        generation,
        scope,
        cursor: page.continueCursor,
      });
    }
    return true;
  },
});

export const getRecentWellnessDaily = internalQuery({
  args: { userId: v.id("users"), limit: v.number() },
  handler: async (ctx, { userId, limit }) => {
    const connection = await ctx.db
      .query("fitbitConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!connection || connection.status !== "active") return [];
    return ctx.db
      .query("fitbitWellnessDaily")
      .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
        q.eq("userId", userId).eq("generation", connection.generation),
      )
      .order("desc")
      .take(Math.max(0, Math.min(Math.floor(limit), MAX_RECENT_FITBIT_WELLNESS_ROWS)));
  },
});
