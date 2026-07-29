import { isRateLimitError } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx, internalAction, internalMutation } from "../_generated/server";
import { rateLimiter } from "../rateLimits";
import {
  createFitbitListBudget,
  type FitbitDataType,
  fitbitDataTypesForScopes,
  listFitbitDataPoints,
} from "./client";
import { isFitbitConfigured } from "./config";
import { normalizeFitbitExercises, normalizeFitbitWellness } from "./normalizers";
import { revokeEncryptedFitbitToken } from "./tokenRevocation";

export { revokeFitbitTokenWithRetry } from "./tokenRevocation";

const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DUE_BATCH_SIZE = 25;
const MIN_SYNC_DAYS = 1;
const MAX_SYNC_DAYS = 30;
const CLEANUP_BATCH_SIZE = 50;

export type FitbitSyncResult =
  { success: true; activities: number; wellnessDays: number } | { success: false; error: string };

export function fitbitSyncStartDate(now: number, days: number): string {
  return new Date(now - (days - 1) * DAY_MS).toISOString().slice(0, 10);
}

export function buildFitbitSyncFilters(startDate: string): Record<FitbitDataType, string> {
  return {
    exercise: `exercise.interval.civil_start_time >= "${startDate}"`,
    sleep: `sleep.interval.civil_end_time >= "${startDate}"`,
    "daily-resting-heart-rate": `daily_resting_heart_rate.date >= "${startDate}"`,
    "daily-heart-rate-variability": `daily_heart_rate_variability.date >= "${startDate}"`,
  };
}

function publicSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("authorization expired")) return "Fitbit authorization expired.";
  if (message.includes("permissions were revoked")) return "Fitbit permissions were revoked.";
  if (message.includes("permission is not granted")) return "A Fitbit permission is unavailable.";
  if (message.includes("not connected") || message.includes("connection changed")) {
    return "Fitbit is not connected.";
  }
  if (message.includes("pagination")) return "Fitbit returned too much data for one sync window.";
  if (message.includes("Malformed")) return "Fitbit returned malformed health data.";
  const status = message.match(/HTTP ([0-9]{3})/)?.[1];
  return status ? `Fitbit sync failed with HTTP ${status}.` : "Fitbit sync failed.";
}

async function runSync(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  userId: Id<"users">,
  generation: string,
  days: number,
): Promise<FitbitSyncResult> {
  if (!isFitbitConfigured()) {
    return { success: false, error: "Fitbit integration is not available on this deployment." };
  }
  if (!Number.isInteger(days) || days < MIN_SYNC_DAYS || days > MAX_SYNC_DAYS) {
    return { success: false, error: `days must be between ${MIN_SYNC_DAYS} and ${MAX_SYNC_DAYS}` };
  }
  const deletionInProgress: boolean = await ctx.runQuery(internal.lib.auth.getDeletionInProgress, {
    userId,
  });
  if (deletionInProgress) {
    return { success: false, error: "Account deletion is in progress." };
  }
  const connection = await ctx.runQuery(internal.fitbit.connections.getActiveConnectionByUserId, {
    userId,
  });
  if (!connection || connection.generation !== generation) {
    return { success: false, error: "Fitbit is not connected." };
  }

  const now = Date.now();
  const startDate = fitbitSyncStartDate(now, days);
  const filters = buildFitbitSyncFilters(startDate);
  const points: Record<FitbitDataType, unknown[]> = {
    exercise: [],
    sleep: [],
    "daily-resting-heart-rate": [],
    "daily-heart-rate-variability": [],
  };
  const dataTypes = fitbitDataTypesForScopes(connection.scopes);
  const budget = createFitbitListBudget(now);
  try {
    // Sequential reads avoid racing refresh-token rotation.
    for (const dataType of dataTypes) {
      points[dataType] = await listFitbitDataPoints(ctx, {
        userId,
        generation,
        dataType,
        filter: filters[dataType],
        budget,
      });
    }
    const activities = normalizeFitbitExercises(points.exercise);
    const wellness = normalizeFitbitWellness({
      sleeps: points.sleep,
      restingHeartRates: points["daily-resting-heart-rate"],
      heartRateVariability: points["daily-heart-rate-variability"],
    });

    if (dataTypes.includes("exercise")) {
      const reconciled = await ctx.runMutation(
        internal.fitbit.activityPersistence.reconcileExternalActivities,
        {
          userId,
          activities,
          generation,
          startDate,
          now,
        },
      );
      if (!reconciled) throw new Error("Fitbit connection changed during sync");
    }
    if (dataTypes.some((dataType) => dataType !== "exercise")) {
      const reconciled = await ctx.runMutation(internal.fitbit.wellnessDaily.upsertWellnessDaily, {
        userId,
        generation,
        startDate,
        syncedDataTypes: dataTypes.filter((dataType) => dataType !== "exercise"),
        entries: wellness,
        now,
      });
      if (!reconciled) throw new Error("Fitbit connection changed during sync");
    }
    const recorded = await ctx.runMutation(internal.fitbit.connections.recordSyncResult, {
      userId,
      generation,
      now,
      nextRefreshDueAt: now + SYNC_INTERVAL_MS,
    });
    if (!recorded) return { success: false, error: "Fitbit is not connected." };
    return { success: true, activities: activities.length, wellnessDays: wellness.length };
  } catch (error) {
    const safeError = publicSyncError(error);
    let recorded: boolean;
    try {
      recorded = await ctx.runMutation(internal.fitbit.connections.recordSyncResult, {
        userId,
        generation,
        now,
        nextRefreshDueAt: now + SYNC_INTERVAL_MS,
        error: safeError,
      });
    } catch {
      return { success: false, error: safeError };
    }
    return recorded
      ? { success: false, error: safeError }
      : { success: false, error: "Fitbit is not connected." };
  }
}

export const syncConnection = internalAction({
  args: { userId: v.id("users"), generation: v.string(), days: v.number() },
  handler: async (ctx, args): Promise<FitbitSyncResult> =>
    runSync(ctx, args.userId, args.generation, args.days),
});

export const refreshFitbitData = action({
  args: {},
  handler: async (ctx): Promise<FitbitSyncResult> => {
    const userId: Id<"users"> | null = await ctx.runQuery(
      internal.lib.auth.resolveEffectiveUserId,
      {},
    );
    if (!userId) return { success: false, error: "Not authenticated" };
    if (!isFitbitConfigured()) {
      return { success: false, error: "Fitbit integration is not available on this deployment." };
    }
    try {
      await rateLimiter.limit(ctx, "refreshFitbitData", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) {
        return {
          success: false,
          error: "Fitbit refresh is limited. Please wait before trying again.",
        };
      }
      console.error("[fitbitSync] failed to acquire manual refresh slot", { userId });
      return { success: false, error: "Unable to refresh Fitbit right now." };
    }
    const connection = await ctx.runQuery(internal.fitbit.connections.getActiveConnectionByUserId, {
      userId,
    });
    if (!connection) return { success: false, error: "Fitbit is not connected." };
    return runSync(ctx, userId, connection.generation, MAX_SYNC_DAYS);
  },
});

export const scheduleDueSyncs = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    if (!isFitbitConfigured()) return 0;
    const claimed: Array<{ userId: Id<"users">; generation: string }> = await ctx.runMutation(
      internal.fitbit.connections.claimDueConnections,
      { now: Date.now(), limit: DUE_BATCH_SIZE },
    );
    for (const connection of claimed) {
      await ctx.scheduler.runAfter(0, internal.fitbit.sync.syncConnection, {
        ...connection,
        days: MAX_SYNC_DAYS,
      });
    }
    if (claimed.length === DUE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.fitbit.sync.scheduleDueSyncs, {});
    }
    return claimed.length;
  },
});

export const sweepExpiredOauthArtifacts = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const result: { deleted: number; hasMore: boolean } = await ctx.runMutation(
      internal.fitbit.oauthArtifacts.sweepExpired,
      { now: Date.now() },
    );
    if (result.hasMore) {
      await ctx.scheduler.runAfter(0, internal.fitbit.sync.sweepExpiredOauthArtifacts, {});
    }
    return result.deleted;
  },
});

export const cleanupFitbitData = internalMutation({
  args: { userId: v.id("users"), generation: v.string() },
  handler: async (ctx, { userId, generation }) => {
    const [activities, wellness] = await Promise.all([
      ctx.db
        .query("externalActivities")
        .withIndex("by_userId_and_fitbitConnectionGeneration_and_externalId", (q) =>
          q.eq("userId", userId).eq("fitbitConnectionGeneration", generation),
        )
        .take(CLEANUP_BATCH_SIZE),
      ctx.db
        .query("fitbitWellnessDaily")
        .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
          q.eq("userId", userId).eq("generation", generation),
        )
        .take(CLEANUP_BATCH_SIZE),
    ]);
    for (const row of [...activities, ...wellness]) await ctx.db.delete(row._id);
    if (activities.length === CLEANUP_BATCH_SIZE || wellness.length === CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.fitbit.sync.cleanupFitbitData, {
        userId,
        generation,
      });
    }
  },
});

export const revokeForAccountDeletion = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<boolean> => {
    const connection = await ctx.runQuery(internal.fitbit.connections.getActiveConnectionByUserId, {
      userId,
    });
    return connection ? revokeEncryptedFitbitToken(connection.refreshTokenEncrypted) : true;
  },
});

export type DisconnectFitbitResult =
  { success: true; warning?: string } | { success: false; error: string };

export const disconnectMyFitbit = action({
  args: {},
  handler: async (ctx): Promise<DisconnectFitbitResult> => {
    const userId: Id<"users"> | null = await ctx.runQuery(
      internal.lib.auth.resolveEffectiveUserId,
      {},
    );
    if (!userId) return { success: false, error: "Not authenticated" };
    try {
      await rateLimiter.limit(ctx, "disconnectMyFitbit", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) {
        return { success: false, error: "Too many Fitbit disconnect attempts. Try again later." };
      }
      return { success: false, error: "Unable to disconnect Fitbit right now." };
    }

    const claimed = await ctx.runMutation(internal.fitbit.connections.claimDisconnect, {
      userId,
      reason: "user_disconnected",
      now: Date.now(),
    });
    if (!claimed) return { success: true };
    const revoked = await revokeEncryptedFitbitToken(claimed.refreshTokenEncrypted);
    if (!revoked) {
      console.error("[fitbitSync] Google token revocation failed", { userId });
    }
    return revoked
      ? { success: true }
      : {
          success: true,
          warning: "Google token revocation failed; local Fitbit data was disconnected.",
        };
  },
});
