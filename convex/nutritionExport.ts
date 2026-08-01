import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type ActionCtx, internalQuery } from "./_generated/server";

const EXPORT_PAGE_SIZE = 500;

const dailyLogDocumentValidator = v.object({
  _id: v.id("nutritionDailyLogs"),
  _creationTime: v.number(),
  userId: v.id("users"),
  calendarDate: v.string(),
  source: v.literal("manual"),
  caloriesKcal: v.optional(v.number()),
  proteinGrams: v.optional(v.number()),
  carbsGrams: v.optional(v.number()),
  fatGrams: v.optional(v.number()),
  notes: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const targetsDocumentValidator = v.object({
  _id: v.id("nutritionTargets"),
  _creationTime: v.number(),
  userId: v.id("users"),
  source: v.literal("self_set"),
  caloriesKcal: v.optional(v.number()),
  proteinGrams: v.optional(v.number()),
  carbsGrams: v.optional(v.number()),
  fatGrams: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const listDailyLogPage = internalQuery({
  args: { userId: v.id("users"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    page: v.array(dailyLogDocumentValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { userId, cursor }) => {
    const result = await ctx.db
      .query("nutritionDailyLogs")
      .withIndex("by_userId_and_calendarDate", (q) => q.eq("userId", userId))
      .order("asc")
      .paginate({ cursor, numItems: EXPORT_PAGE_SIZE });
    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const listTargetsPage = internalQuery({
  args: { userId: v.id("users"), cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    page: v.array(targetsDocumentValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, { userId, cursor }) => {
    const result = await ctx.db
      .query("nutritionTargets")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .order("asc")
      .paginate({ cursor, numItems: EXPORT_PAGE_SIZE });
    return {
      page: result.page,
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export interface NutritionDailyLogExportRow {
  readonly calendarDate: string;
  readonly source: "manual";
  readonly caloriesKcal: number | null;
  readonly proteinGrams: number | null;
  readonly carbsGrams: number | null;
  readonly fatGrams: number | null;
  readonly notes: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NutritionTargetsExportRow {
  readonly source: "self_set";
  readonly caloriesKcal: number | null;
  readonly proteinGrams: number | null;
  readonly carbsGrams: number | null;
  readonly fatGrams: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NutritionExportData {
  readonly nutritionDailyLogs: readonly NutritionDailyLogExportRow[];
  readonly nutritionTargets: readonly NutritionTargetsExportRow[];
}

interface ExportPage<T> {
  readonly page: readonly T[];
  readonly isDone: boolean;
  readonly continueCursor: string;
}

async function collectPages<T>(
  readPage: (cursor: string | null) => Promise<ExportPage<T>>,
): Promise<readonly T[]> {
  const rows: T[] = [];
  const seenCursors = new Set<string | null>([null]);
  let cursor: string | null = null;

  while (true) {
    const result = await readPage(cursor);
    rows.push(...result.page);
    if (result.isDone) return rows;
    if (seenCursors.has(result.continueCursor)) {
      throw new Error("Nutrition export pagination cursor did not advance");
    }
    cursor = result.continueCursor;
    seenCursors.add(cursor);
  }
}

function compareDailyLogs(
  first: Doc<"nutritionDailyLogs">,
  second: Doc<"nutritionDailyLogs">,
): number {
  return (
    first.calendarDate.localeCompare(second.calendarDate) ||
    first._creationTime - second._creationTime ||
    first._id.localeCompare(second._id)
  );
}

function compareTargets(first: Doc<"nutritionTargets">, second: Doc<"nutritionTargets">): number {
  return (
    first.createdAt - second.createdAt ||
    first._creationTime - second._creationTime ||
    first._id.localeCompare(second._id)
  );
}

export async function collectNutritionExportData(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<NutritionExportData> {
  const [dailyLogs, targets] = await Promise.all([
    collectPages((cursor) =>
      ctx.runQuery(internal.nutritionExport.listDailyLogPage, { userId, cursor }),
    ),
    collectPages((cursor) =>
      ctx.runQuery(internal.nutritionExport.listTargetsPage, { userId, cursor }),
    ),
  ]);

  return {
    nutritionDailyLogs: [...dailyLogs].sort(compareDailyLogs).map((row) => ({
      calendarDate: row.calendarDate,
      source: row.source,
      caloriesKcal: row.caloriesKcal ?? null,
      proteinGrams: row.proteinGrams ?? null,
      carbsGrams: row.carbsGrams ?? null,
      fatGrams: row.fatGrams ?? null,
      notes: row.notes ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    nutritionTargets: [...targets].sort(compareTargets).map((row) => ({
      source: row.source,
      caloriesKcal: row.caloriesKcal ?? null,
      proteinGrams: row.proteinGrams ?? null,
      carbsGrams: row.carbsGrams ?? null,
      fatGrams: row.fatGrams ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  };
}
