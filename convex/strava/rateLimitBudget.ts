import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";

const SHORT_WINDOW_MS = 15 * 60 * 1000;
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRANSPORT_BACKOFF_MS = 30 * 1000;
const CONFIGURED_SHORT_CAP = 100;
const CONFIGURED_DAILY_CAP = 1_000;

const observedBudgetValidator = v.object({
  overallShortLimit: v.number(),
  overallDailyLimit: v.number(),
  overallShortUsage: v.number(),
  overallDailyUsage: v.number(),
  readShortLimit: v.number(),
  readDailyLimit: v.number(),
  readShortUsage: v.number(),
  readDailyUsage: v.number(),
});

export type ObservedStravaRateLimitBudget = typeof observedBudgetValidator.type;
export type StravaBudgetReservation =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number; reason: "awaiting_headers" | "unknown" | "exhausted" };

type BudgetDocument = Omit<Doc<"stravaRateLimitBudget">, "_id" | "_creationTime">;

function requireTimestamp(now: number): void {
  if (!Number.isFinite(now) || now < 0) throw new Error("Invalid Strava budget timestamp");
}

function shortWindowStartedAt(now: number): number {
  return Math.floor(now / SHORT_WINDOW_MS) * SHORT_WINDOW_MS;
}

function dailyWindowStartedAt(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function nextShortWindow(now: number): number {
  return shortWindowStartedAt(now) + SHORT_WINDOW_MS;
}

function nextDailyWindow(now: number): number {
  return dailyWindowStartedAt(now) + DAILY_WINDOW_MS;
}

function parsePair(raw: string | null, requirePositive: boolean): [number, number] | null {
  if (!raw) return null;
  const match = raw.match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
  if (!match) return null;
  const pair: [number, number] = [Number(match[1]), Number(match[2])];
  if (!pair.every(Number.isSafeInteger)) return null;
  if (requirePositive && pair.some((value) => value <= 0)) return null;
  return pair;
}

/** Parse all four documented headers; partial or malformed observations are unusable. */
export function parseStravaRateLimitHeaders(
  headers: Pick<Headers, "get">,
): ObservedStravaRateLimitBudget | null {
  const overallLimits = parsePair(headers.get("X-RateLimit-Limit"), true);
  const overallUsage = parsePair(headers.get("X-RateLimit-Usage"), false);
  const readLimits = parsePair(headers.get("X-ReadRateLimit-Limit"), true);
  const readUsage = parsePair(headers.get("X-ReadRateLimit-Usage"), false);
  if (!overallLimits || !overallUsage || !readLimits || !readUsage) return null;
  return {
    overallShortLimit: overallLimits[0],
    overallDailyLimit: overallLimits[1],
    overallShortUsage: overallUsage[0],
    overallDailyUsage: overallUsage[1],
    readShortLimit: readLimits[0],
    readDailyLimit: readLimits[1],
    readShortUsage: readUsage[0],
    readDailyUsage: readUsage[1],
  };
}

function validateObservedBudget(observed: ObservedStravaRateLimitBudget): void {
  const limits = [
    observed.overallShortLimit,
    observed.overallDailyLimit,
    observed.readShortLimit,
    observed.readDailyLimit,
  ];
  const usage = [
    observed.overallShortUsage,
    observed.overallDailyUsage,
    observed.readShortUsage,
    observed.readDailyUsage,
  ];
  if (
    limits.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    usage.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error("Invalid Strava rate limit observation");
  }
}

function bootstrapBudget(now: number): BudgetDocument {
  return {
    key: "global",
    shortWindowStartedAt: shortWindowStartedAt(now),
    dailyWindowStartedAt: dailyWindowStartedAt(now),
    shortLimit: CONFIGURED_SHORT_CAP,
    dailyLimit: CONFIGURED_DAILY_CAP,
    shortReserved: 1,
    dailyReserved: 1,
    shortObservedUsage: 0,
    dailyObservedUsage: 0,
    awaitingHeadersUntil: now + TRANSPORT_BACKOFF_MS,
    updatedAt: now,
  };
}

function resetWindows(row: Doc<"stravaRateLimitBudget">, now: number): BudgetDocument {
  const shortStart = shortWindowStartedAt(now);
  const dailyStart = dailyWindowStartedAt(now);
  return {
    key: "global",
    shortWindowStartedAt: shortStart,
    dailyWindowStartedAt: dailyStart,
    shortLimit: row.shortLimit,
    dailyLimit: row.dailyLimit,
    shortReserved: row.shortWindowStartedAt === shortStart ? row.shortReserved : 0,
    dailyReserved: row.dailyWindowStartedAt === dailyStart ? row.dailyReserved : 0,
    shortObservedUsage: row.shortWindowStartedAt === shortStart ? row.shortObservedUsage : 0,
    dailyObservedUsage: row.dailyWindowStartedAt === dailyStart ? row.dailyObservedUsage : 0,
    awaitingHeadersUntil:
      row.awaitingHeadersUntil !== undefined && row.awaitingHeadersUntil > now
        ? row.awaitingHeadersUntil
        : undefined,
    blockedUntil: row.blockedUntil,
    updatedAt: now,
  };
}

async function readBudget(ctx: MutationCtx): Promise<Doc<"stravaRateLimitBudget"> | null> {
  return ctx.db
    .query("stravaRateLimitBudget")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique();
}

export async function reserveStravaRateLimitBudget(
  ctx: MutationCtx,
  now: number,
): Promise<StravaBudgetReservation> {
  requireTimestamp(now);
  const existing = await readBudget(ctx);
  if (!existing) {
    await ctx.db.insert("stravaRateLimitBudget", bootstrapBudget(now));
    return { allowed: true };
  }

  if (existing.blockedUntil) {
    if (existing.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterMs: existing.blockedUntil - now,
        reason: "unknown",
      };
    }
    await ctx.db.replace(existing._id, bootstrapBudget(now));
    return { allowed: true };
  }
  if (existing.awaitingHeadersUntil && existing.awaitingHeadersUntil > now) {
    return {
      allowed: false,
      retryAfterMs: existing.awaitingHeadersUntil - now,
      reason: "awaiting_headers",
    };
  }
  const budget = resetWindows(existing, now);
  if (budget.blockedUntil && budget.blockedUntil <= now) budget.blockedUntil = undefined;
  const shortUsed = Math.max(budget.shortReserved, budget.shortObservedUsage);
  const dailyUsed = Math.max(budget.dailyReserved, budget.dailyObservedUsage);
  const shortExhausted = shortUsed + 1 > budget.shortLimit;
  const dailyExhausted = dailyUsed + 1 > budget.dailyLimit;
  if (shortExhausted || dailyExhausted) {
    const retryAt = dailyExhausted ? nextDailyWindow(now) : nextShortWindow(now);
    return { allowed: false, retryAfterMs: Math.max(1, retryAt - now), reason: "exhausted" };
  }

  await ctx.db.replace(existing._id, {
    ...budget,
    shortReserved: shortUsed + 1,
    dailyReserved: dailyUsed + 1,
    blockedUntil: undefined,
  });
  return { allowed: true };
}

export async function recordStravaRateLimitBudget(
  ctx: MutationCtx,
  observed: ObservedStravaRateLimitBudget,
  now: number,
): Promise<void> {
  requireTimestamp(now);
  validateObservedBudget(observed);
  const existing = await readBudget(ctx);
  const current = existing ? resetWindows(existing, now) : bootstrapBudget(now);
  const observedShortUsage = Math.max(observed.overallShortUsage, observed.readShortUsage);
  const observedDailyUsage = Math.max(observed.overallDailyUsage, observed.readDailyUsage);
  const next: BudgetDocument = {
    ...current,
    shortLimit: Math.min(CONFIGURED_SHORT_CAP, observed.overallShortLimit, observed.readShortLimit),
    dailyLimit: Math.min(CONFIGURED_DAILY_CAP, observed.overallDailyLimit, observed.readDailyLimit),
    shortReserved: Math.max(current.shortReserved, observedShortUsage),
    dailyReserved: Math.max(current.dailyReserved, observedDailyUsage),
    shortObservedUsage: Math.max(current.shortObservedUsage, observedShortUsage),
    dailyObservedUsage: Math.max(current.dailyObservedUsage, observedDailyUsage),
    awaitingHeadersUntil: undefined,
    blockedUntil: undefined,
    updatedAt: now,
  };
  if (existing) await ctx.db.replace(existing._id, next);
  else await ctx.db.insert("stravaRateLimitBudget", next);
}

export async function markStravaRateLimitBudgetUnknown(
  ctx: MutationCtx,
  now: number,
): Promise<void> {
  requireTimestamp(now);
  const existing = await readBudget(ctx);
  if (!existing) return;
  await ctx.db.patch(existing._id, {
    awaitingHeadersUntil: undefined,
    blockedUntil: nextDailyWindow(now),
    updatedAt: now,
  });
}

export async function markStravaRateLimitTransportFailure(
  ctx: MutationCtx,
  now: number,
): Promise<void> {
  requireTimestamp(now);
  const existing = await readBudget(ctx);
  if (!existing || (existing.blockedUntil !== undefined && existing.blockedUntil > now)) return;
  await ctx.db.patch(existing._id, {
    awaitingHeadersUntil: now + TRANSPORT_BACKOFF_MS,
    updatedAt: now,
  });
}

export const reserveRequest = internalMutation({
  args: { now: v.number() },
  returns: v.union(
    v.object({ allowed: v.literal(true) }),
    v.object({
      allowed: v.literal(false),
      retryAfterMs: v.number(),
      reason: v.union(v.literal("awaiting_headers"), v.literal("unknown"), v.literal("exhausted")),
    }),
  ),
  handler: async (ctx, { now }) => reserveStravaRateLimitBudget(ctx, now),
});

export const recordResponseHeaders = internalMutation({
  args: { now: v.number(), observed: observedBudgetValidator },
  returns: v.null(),
  handler: async (ctx, { now, observed }) => {
    await recordStravaRateLimitBudget(ctx, observed, now);
    return null;
  },
});

export const markResponseUnknown = internalMutation({
  args: { now: v.number() },
  returns: v.null(),
  handler: async (ctx, { now }) => {
    await markStravaRateLimitBudgetUnknown(ctx, now);
    return null;
  },
});

export const markTransportFailure = internalMutation({
  args: { now: v.number() },
  returns: v.null(),
  handler: async (ctx, { now }) => {
    await markStravaRateLimitTransportFailure(ctx, now);
    return null;
  },
});
