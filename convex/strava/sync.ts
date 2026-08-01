import { isRateLimitError } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx, internalAction } from "../_generated/server";
import { rateLimiter } from "../rateLimits";
import { requestStravaApi, STRAVA_BUDGET_DENIED_HEADER } from "./apiRequest";
import { parsePublicStravaActivityList } from "./activitySchema";
import type { StravaAuthorizedFetchResult } from "./client";
import { STRAVA_API_BASE_URL } from "./config";

const INITIAL_SYNC_DAYS = 30;
const MAX_SYNC_PAGES = 2;
const ACTIVITIES_PER_PAGE = 100;
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_INITIAL_SYNC_ATTEMPTS = 3;
const INITIAL_SYNC_RETRY_BASE_MS = 30 * 1_000;
const MAX_INITIAL_SYNC_RETRY_MS = 24 * 60 * 60 * 1_000;

type SyncIdentity = { userId: Id<"users">; athleteId: string; generation: string };
type SyncResult =
  | { success: true; activities: number }
  | { success: false; retryable: boolean; error: string; retryAfterMs?: number };

async function requestPage(
  ctx: ActionCtx,
  identity: SyncIdentity,
  url: URL,
): Promise<Response | Extract<StravaAuthorizedFetchResult, { success: false }>> {
  const fetched = await requestStravaApi(ctx, {
    identity,
    url,
  });
  if (!fetched.success) return fetched;
  return fetched.response;
}

function providerFailure(response: Response): Extract<SyncResult, { success: false }> {
  const budgetDenied = response.headers.get(STRAVA_BUDGET_DENIED_HEADER) === "exhausted";
  const retryAfterSeconds = Number(response.headers.get("Retry-After"));
  const retryAfterMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1_000
      : undefined;
  if (response.status === 429) {
    return {
      success: false,
      retryable: true,
      error: budgetDenied
        ? "Strava sync is waiting for API capacity."
        : "Strava rate limit reached.",
      retryAfterMs,
    };
  }
  if (response.status === 401) {
    return { success: false, retryable: false, error: "Strava authorization is no longer valid." };
  }
  if (response.status === 403) {
    return { success: false, retryable: false, error: "Strava denied activity access." };
  }
  return {
    success: false,
    retryable: response.status >= 500,
    error: response.status >= 500 ? "Strava is temporarily unavailable." : "Strava sync failed.",
  };
}

async function recordFailure(
  ctx: ActionCtx,
  identity: SyncIdentity,
  attemptedAt: number,
  failure: Extract<SyncResult, { success: false }>,
): Promise<SyncResult> {
  try {
    await ctx.runMutation(internal.strava.syncState.recordSyncResult, {
      userId: identity.userId,
      generation: identity.generation,
      attemptedAt,
      result: { status: "failure", error: failure.error },
    });
  } catch {
    console.error("[stravaSync] failed to record sync failure", {
      userId: identity.userId,
      generation: identity.generation,
    });
  }
  return failure;
}

async function markProviderDisconnected(ctx: ActionCtx, identity: SyncIdentity): Promise<boolean> {
  try {
    await ctx.runMutation(internal.strava.syncState.markProviderDisconnected, {
      userId: identity.userId,
      generation: identity.generation,
      reason: "token_invalid",
      now: Date.now(),
    });
    return true;
  } catch {
    console.error("[stravaSync] failed to mark provider disconnected", {
      userId: identity.userId,
      generation: identity.generation,
    });
    return false;
  }
}

async function syncActivities(
  ctx: ActionCtx,
  identity: SyncIdentity,
  attemptedAt: number,
): Promise<SyncResult> {
  let upserted = 0;
  const after = Math.floor((attemptedAt - INITIAL_SYNC_DAYS * DAY_MS) / 1_000);
  const before = Math.floor(attemptedAt / 1_000);
  for (let page = 1; page <= MAX_SYNC_PAGES; page += 1) {
    const url = new URL(`${STRAVA_API_BASE_URL}/athlete/activities`);
    url.searchParams.set("after", String(after));
    url.searchParams.set("before", String(before));
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(ACTIVITIES_PER_PAGE));
    const response = await requestPage(ctx, identity, url);
    if ("success" in response) {
      const failure: Extract<SyncResult, { success: false }> = {
        success: false,
        retryable: response.retryable,
        error: response.error,
        retryAfterMs: response.retryAfterMs,
      };
      if (response.kind === "authorization_invalid") {
        const disconnected = await markProviderDisconnected(ctx, identity);
        if (!disconnected) failure.retryable = true;
      }
      return recordFailure(ctx, identity, attemptedAt, failure);
    }
    if (!response.ok) {
      const failure = providerFailure(response);
      if (!failure.retryable && response.status === 401) {
        const disconnected = await markProviderDisconnected(ctx, identity);
        if (!disconnected) failure.retryable = true;
      }
      return recordFailure(ctx, identity, attemptedAt, failure);
    }
    let pageLength = 0;
    let activities: ReturnType<typeof parsePublicStravaActivityList>;
    try {
      const raw: unknown = await response.json();
      if (!Array.isArray(raw)) throw new Error("Invalid Strava activity list response");
      pageLength = raw.length;
      activities = parsePublicStravaActivityList(raw);
      if (activities.some((activity) => activity.athleteId !== identity.athleteId)) {
        throw new Error("Strava activity owner mismatch");
      }
    } catch {
      return recordFailure(ctx, identity, attemptedAt, {
        success: false,
        retryable: false,
        error: "Strava returned an invalid activity response.",
      });
    }
    let persisted: number | null;
    try {
      persisted = await ctx.runMutation(internal.strava.activityPersistence.upsertActivityBatch, {
        ...identity,
        activities,
        now: attemptedAt,
      });
    } catch {
      console.error("[stravaSync] failed to persist activity batch", {
        userId: identity.userId,
        generation: identity.generation,
      });
      return recordFailure(ctx, identity, attemptedAt, {
        success: false,
        retryable: true,
        error: "Strava activity persistence failed.",
      });
    }
    if (persisted === null) {
      return recordFailure(ctx, identity, attemptedAt, {
        success: false,
        retryable: false,
        error: "Strava connection changed.",
      });
    }
    upserted += persisted;
    if (pageLength < ACTIVITIES_PER_PAGE) break;
  }
  try {
    await ctx.runMutation(internal.strava.syncState.recordSyncResult, {
      userId: identity.userId,
      generation: identity.generation,
      attemptedAt,
      result: { status: "success", succeededAt: Date.now() },
    });
  } catch {
    console.error("[stravaSync] failed to record sync success", {
      userId: identity.userId,
      generation: identity.generation,
    });
    return {
      success: false,
      retryable: true,
      error: "Strava sync bookkeeping failed.",
    };
  }
  return { success: true, activities: upserted };
}

export const runInitialSync = internalAction({
  args: {
    userId: v.id("users"),
    athleteId: v.string(),
    generation: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SyncResult> => {
    const attempt = args.attempt ?? 1;
    if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_INITIAL_SYNC_ATTEMPTS) {
      throw new Error("Invalid Strava initial sync attempt");
    }
    const identity = {
      userId: args.userId,
      athleteId: args.athleteId,
      generation: args.generation,
    };
    const result = await syncActivities(ctx, identity, Date.now());
    if (!result.success && result.retryable && attempt < MAX_INITIAL_SYNC_ATTEMPTS) {
      const requestedDelay = result.retryAfterMs ?? INITIAL_SYNC_RETRY_BASE_MS * 2 ** (attempt - 1);
      const retryAfterMs = Math.min(MAX_INITIAL_SYNC_RETRY_MS, Math.max(1_000, requestedDelay));
      await ctx.scheduler.runAfter(retryAfterMs, internal.strava.sync.runInitialSync, {
        ...identity,
        attempt: attempt + 1,
      });
    }
    return result;
  },
});

export const refreshStravaData = action({
  args: {},
  handler: async (ctx): Promise<SyncResult> => {
    const userId: Id<"users"> | null = await ctx.runQuery(
      internal.lib.auth.resolveEffectiveUserId,
      {},
    );
    if (!userId) throw new Error("Not authenticated");
    try {
      await rateLimiter.limit(ctx, "refreshStravaData", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) throw new Error("Too many Strava sync attempts");
      throw new Error("Unable to sync Strava right now");
    }
    const connection = await ctx.runQuery(internal.strava.connections.getActiveConnectionByUserId, {
      userId,
    });
    if (!connection) return { success: false, retryable: false, error: "Strava is not connected." };
    return syncActivities(
      ctx,
      { userId, athleteId: connection.athleteId, generation: connection.generation },
      Date.now(),
    );
  },
});
