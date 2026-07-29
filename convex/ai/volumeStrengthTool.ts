import { createTool } from "@convex-dev/agent";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { z } from "zod";
import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import {
  analyzeVolumeStrength,
  buildDataLimitExceededAnalysis,
  type VolumeStrengthAnalysis,
  WINDOW_WEEKS,
} from "../coach/volumeStrengthCorrelation";
import { requireUserId, withToolTracking } from "./helpers";

const MAX_PERFORMANCE_ROWS = 3_000;
const MAX_STRENGTH_SNAPSHOTS = 300;
const MAX_MOVEMENT_IDS = 500;

type VolumeStrengthQueryArgs = {
  userId: Id<"users">;
  baselineStartDate: string;
  windowStartDate: string;
  windowEndDate: string;
};

const readVolumeStrengthCorrelationRef = makeFunctionReference<
  "query",
  VolumeStrengthQueryArgs,
  VolumeStrengthAnalysis
>("ai/volumeStrengthTool:readVolumeStrengthCorrelation");

function formatUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function analysisWindow(now: Date): Omit<VolumeStrengthQueryArgs, "userId"> {
  const currentWeekStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  currentWeekStart.setUTCDate(
    currentWeekStart.getUTCDate() - ((currentWeekStart.getUTCDay() + 6) % 7),
  );
  const windowStart = new Date(currentWeekStart);
  windowStart.setUTCDate(windowStart.getUTCDate() - WINDOW_WEEKS * 7);
  const windowEnd = new Date(currentWeekStart);
  windowEnd.setUTCDate(windowEnd.getUTCDate() - 1);
  const baselineStart = new Date(windowStart);
  baselineStart.setUTCDate(baselineStart.getUTCDate() - 7);
  return {
    baselineStartDate: formatUtcDate(baselineStart),
    windowStartDate: formatUtcDate(windowStart),
    windowEndDate: formatUtcDate(windowEnd),
  };
}

export const readVolumeStrengthCorrelation = internalQuery({
  args: {
    userId: v.id("users"),
    baselineStartDate: v.string(),
    windowStartDate: v.string(),
    windowEndDate: v.string(),
  },
  handler: async (ctx, args): Promise<VolumeStrengthAnalysis> => {
    const [performanceRows, strengthSnapshots] = await Promise.all([
      ctx.db
        .query("exercisePerformance")
        .withIndex("by_userId_date", (q) =>
          q
            .eq("userId", args.userId)
            .gte("date", args.windowStartDate)
            .lte("date", args.windowEndDate),
        )
        .order("asc")
        .take(MAX_PERFORMANCE_ROWS + 1),
      ctx.db
        .query("strengthScoreSnapshots")
        .withIndex("by_userId_date", (q) =>
          q
            .eq("userId", args.userId)
            .gte("date", args.baselineStartDate)
            .lte("date", args.windowEndDate),
        )
        .order("asc")
        .take(MAX_STRENGTH_SNAPSHOTS + 1),
    ]);
    if (
      performanceRows.length > MAX_PERFORMANCE_ROWS ||
      strengthSnapshots.length > MAX_STRENGTH_SNAPSHOTS
    ) {
      return buildDataLimitExceededAnalysis();
    }
    const movementIds = [
      ...new Set(performanceRows.map((performance) => performance.movementId)),
    ].slice(0, MAX_MOVEMENT_IDS + 1);
    if (movementIds.length > MAX_MOVEMENT_IDS) return buildDataLimitExceededAnalysis();
    const movements = [];
    for (const tonalId of movementIds) {
      const movement = await ctx.db
        .query("movements")
        .withIndex("by_tonalId", (q) => q.eq("tonalId", tonalId))
        .unique();
      if (movement) movements.push(movement);
    }
    return analyzeVolumeStrength({
      windowStartDate: args.windowStartDate,
      windowEndDate: args.windowEndDate,
      performanceRows,
      strengthSnapshots,
      movements,
    });
  },
});

export const analyzeVolumeStrengthTool = createTool({
  description:
    "Use for observational 26-week regional volume and Tonal Strength Score correlation. Do not infer causal MRV or volume caps. Inputs are empty; returns counts, recency, unmapped movements, provisional Spearman rho, confidence, range, programming eligibility for further MRV estimation, and caveat. Advisory-only results must not influence volume caps.",
  inputSchema: z.object({}),
  execute: withToolTracking("analyze_volume_strength", async (ctx) => {
    const userId = requireUserId(ctx);
    return await ctx.runQuery(readVolumeStrengthCorrelationRef, {
      userId,
      ...analysisWindow(new Date()),
    });
  }),
});
