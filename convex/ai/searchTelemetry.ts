import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export interface CrossThreadSearchTelemetryRow {
  retrievalEnabled?: boolean;
  searchHits?: number;
  searchUsed?: boolean;
}

export interface CrossThreadSearchTelemetrySummary {
  instrumentedTurns: number;
  legacyTurns: number;
  retrievalEnabledTurns: number;
  retrievalDisabledTurns: number;
  retrievalUnknownTurns: number;
  hitTurns: number;
  usedTurns: number;
  enabledHitTurns: number;
  enabledUsedTurns: number;
  totalHits: number;
  hitRateEnabled: number;
  usedRateEnabled: number;
  hitRateAll: number;
  usedRateAll: number;
  usedGivenHitRate: number;
}

function safeRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Summarize only complete search telemetry; historical partial rows remain legacy. */
export function aggregateCrossThreadSearchTelemetry(
  rows: readonly CrossThreadSearchTelemetryRow[],
): CrossThreadSearchTelemetrySummary {
  let instrumentedTurns = 0;
  let legacyTurns = 0;
  let retrievalEnabledTurns = 0;
  let retrievalDisabledTurns = 0;
  let retrievalUnknownTurns = 0;
  let hitTurns = 0;
  let usedTurns = 0;
  let enabledHitTurns = 0;
  let enabledUsedTurns = 0;
  let totalHits = 0;

  for (const row of rows) {
    const isInstrumented =
      typeof row.searchHits === "number" &&
      Number.isFinite(row.searchHits) &&
      row.searchHits >= 0 &&
      typeof row.searchUsed === "boolean";
    if (!isInstrumented) {
      legacyTurns += 1;
      continue;
    }

    instrumentedTurns += 1;
    const hasHits = row.searchHits! > 0;
    const wasUsed = row.searchUsed! && hasHits;
    totalHits += row.searchHits!;
    if (hasHits) hitTurns += 1;
    if (wasUsed) usedTurns += 1;

    if (row.retrievalEnabled === true) {
      retrievalEnabledTurns += 1;
      if (hasHits) enabledHitTurns += 1;
      if (wasUsed) enabledUsedTurns += 1;
    } else if (row.retrievalEnabled === false) {
      retrievalDisabledTurns += 1;
    } else {
      retrievalUnknownTurns += 1;
    }
  }

  return {
    instrumentedTurns,
    legacyTurns,
    retrievalEnabledTurns,
    retrievalDisabledTurns,
    retrievalUnknownTurns,
    hitTurns,
    usedTurns,
    enabledHitTurns,
    enabledUsedTurns,
    totalHits,
    hitRateEnabled: safeRate(enabledHitTurns, retrievalEnabledTurns),
    usedRateEnabled: safeRate(enabledUsedTurns, retrievalEnabledTurns),
    hitRateAll: safeRate(hitTurns, instrumentedTurns),
    usedRateAll: safeRate(usedTurns, instrumentedTurns),
    usedGivenHitRate: safeRate(usedTurns, hitTurns),
  };
}

const DEFAULT_SEARCH_TELEMETRY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SEARCH_TELEMETRY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SEARCH_TELEMETRY_ROWS = 2_000;

export function validateSearchTelemetryWindowMs(
  windowMs: number = DEFAULT_SEARCH_TELEMETRY_WINDOW_MS,
): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0 || windowMs > MAX_SEARCH_TELEMETRY_WINDOW_MS) {
    throw new Error("windowMs must be greater than 0 and at most 90 days");
  }
  return windowMs;
}

/** Bounded operator-facing rollup for the #206 observation window. */
export const getCrossThreadSearchTelemetry = internalQuery({
  args: {
    environment: v.union(v.literal("dev"), v.literal("prod")),
    windowMs: v.optional(v.number()),
  },
  handler: async (ctx, { environment, windowMs }) => {
    const normalizedWindowMs = validateSearchTelemetryWindowMs(windowMs);
    const until = Date.now();
    const since = until - normalizedWindowMs;
    const rowsWithSentinel = await ctx.db
      .query("aiRun")
      .withIndex("by_environment_and_createdAt", (q) =>
        q.eq("environment", environment).gte("createdAt", since).lte("createdAt", until),
      )
      .order("desc")
      .take(MAX_SEARCH_TELEMETRY_ROWS + 1);
    const truncated = rowsWithSentinel.length > MAX_SEARCH_TELEMETRY_ROWS;
    const rows = truncated
      ? rowsWithSentinel.slice(0, MAX_SEARCH_TELEMETRY_ROWS)
      : rowsWithSentinel;

    return {
      environment,
      since,
      until,
      truncated,
      analyzedTurns: rows.length,
      ...aggregateCrossThreadSearchTelemetry(rows),
    };
  },
});
