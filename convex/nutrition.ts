import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getEffectiveUserId } from "./lib/auth";
import {
  assertValidNutritionCalendarDate,
  DEFAULT_NUTRITION_LIST_LIMIT,
  MAX_NUTRITION_LIST_LIMIT,
  normalizeNutritionDailyLog,
  normalizeNutritionTargets,
  type NutritionDailyLogView,
  nutritionDailyLogViewValidator,
  nutritionMetricArgs,
  type NutritionTargetsView,
  nutritionTargetsViewValidator,
  toNutritionDailyLogView,
  toNutritionTargetsView,
} from "./nutritionContract";
import { rateLimiter } from "./rateLimits";

export const listRecentMine = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(nutritionDailyLogViewValidator),
  handler: async (ctx, { limit }): Promise<NutritionDailyLogView[]> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return [];
    const requestedLimit = limit ?? DEFAULT_NUTRITION_LIST_LIMIT;
    if (
      !Number.isInteger(requestedLimit) ||
      requestedLimit < 1 ||
      requestedLimit > MAX_NUTRITION_LIST_LIMIT
    ) {
      throw new Error(`limit must be an integer from 1 to ${MAX_NUTRITION_LIST_LIMIT}`);
    }
    const rows = await ctx.db
      .query("nutritionDailyLogs")
      .withIndex("by_userId_and_calendarDate", (q) => q.eq("userId", userId))
      .order("desc")
      .take(requestedLimit);
    return rows.map(toNutritionDailyLogView);
  },
});

export const getDailyMine = query({
  args: { calendarDate: v.string() },
  returns: v.union(nutritionDailyLogViewValidator, v.null()),
  handler: async (ctx, { calendarDate }): Promise<NutritionDailyLogView | null> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return null;
    assertValidNutritionCalendarDate(calendarDate);
    const row = await ctx.db
      .query("nutritionDailyLogs")
      .withIndex("by_userId_and_calendarDate", (q) =>
        q.eq("userId", userId).eq("calendarDate", calendarDate),
      )
      .unique();
    return row ? toNutritionDailyLogView(row) : null;
  },
});

export const upsertDailyMine = mutation({
  args: {
    calendarDate: v.string(),
    ...nutritionMetricArgs,
    notes: v.optional(v.string()),
  },
  returns: nutritionDailyLogViewValidator,
  handler: async (ctx, args): Promise<NutritionDailyLogView> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const normalized = normalizeNutritionDailyLog(args);
    await rateLimiter.limit(ctx, "saveNutrition", { key: userId, throws: true });

    const existing = await ctx.db
      .query("nutritionDailyLogs")
      .withIndex("by_userId_and_calendarDate", (q) =>
        q.eq("userId", userId).eq("calendarDate", normalized.calendarDate),
      )
      .unique();
    const now = Date.now();
    const replacement = {
      userId,
      source: "manual" as const,
      ...normalized,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const logId = existing?._id ?? (await ctx.db.insert("nutritionDailyLogs", replacement));
    if (existing) await ctx.db.replace(existing._id, replacement);
    const saved = await ctx.db.get("nutritionDailyLogs", logId);
    if (!saved) throw new Error("Nutrition daily log not found");
    return toNutritionDailyLogView(saved);
  },
});

export const deleteDailyMine = mutation({
  args: { calendarDate: v.string() },
  returns: v.null(),
  handler: async (ctx, { calendarDate }): Promise<null> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    assertValidNutritionCalendarDate(calendarDate);
    await rateLimiter.limit(ctx, "deleteNutrition", { key: userId, throws: true });
    const existing = await ctx.db
      .query("nutritionDailyLogs")
      .withIndex("by_userId_and_calendarDate", (q) =>
        q.eq("userId", userId).eq("calendarDate", calendarDate),
      )
      .unique();
    if (!existing) throw new Error("Nutrition daily log not found");
    await ctx.db.delete(existing._id);
    return null;
  },
});

export const getTargetsMine = query({
  args: {},
  returns: v.union(nutritionTargetsViewValidator, v.null()),
  handler: async (ctx): Promise<NutritionTargetsView | null> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return null;
    const targets = await ctx.db
      .query("nutritionTargets")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    return targets ? toNutritionTargetsView(targets) : null;
  },
});

export const setTargetsMine = mutation({
  args: nutritionMetricArgs,
  returns: nutritionTargetsViewValidator,
  handler: async (ctx, args): Promise<NutritionTargetsView> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const normalized = normalizeNutritionTargets(args);
    await rateLimiter.limit(ctx, "updateNutritionTargets", { key: userId, throws: true });

    const existing = await ctx.db
      .query("nutritionTargets")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    const now = Date.now();
    const replacement = {
      userId,
      source: "self_set" as const,
      ...normalized,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    const targetId = existing?._id ?? (await ctx.db.insert("nutritionTargets", replacement));
    if (existing) await ctx.db.replace(existing._id, replacement);
    const saved = await ctx.db.get("nutritionTargets", targetId);
    if (!saved) throw new Error("Nutrition targets not found");
    return toNutritionTargetsView(saved);
  },
});

export const clearTargetsMine = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await rateLimiter.limit(ctx, "updateNutritionTargets", { key: userId, throws: true });
    const existing = await ctx.db
      .query("nutritionTargets")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});
