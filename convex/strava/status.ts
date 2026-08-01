import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalQuery, query } from "../_generated/server";
import { getEffectiveUserId } from "../lib/auth";
import { isStravaFeatureConfigured, supportedStravaScopes } from "./config";

export type StravaConnectionStatus =
  | { state: "none" }
  | {
      state: "active";
      connectedAt: number;
      lastSyncedAt?: number;
      scopes: string[];
    }
  | {
      state: "disconnected";
      connectedAt: number;
      disconnectedAt: number;
      scopes: string[];
    };

export const hasActiveConnectionByUserId = internalQuery({
  args: { userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    return row?.status === "active";
  },
});

export const getStravaFeatureStatus = action({
  args: {},
  returns: v.object({ configured: v.boolean(), hasConnection: v.boolean() }),
  handler: async (ctx): Promise<{ configured: boolean; hasConnection: boolean }> => {
    const userId: Id<"users"> | null = await ctx.runQuery(
      internal.lib.auth.resolveEffectiveUserId,
      {},
    );
    if (!userId) return { configured: false, hasConnection: false };
    const hasConnection: boolean = await ctx.runQuery(
      internal.strava.status.hasActiveConnectionByUserId,
      { userId },
    );
    return { configured: isStravaFeatureConfigured(), hasConnection };
  },
});

export const getMyStravaStatus = query({
  args: {},
  returns: v.union(
    v.object({ state: v.literal("none") }),
    v.object({
      state: v.literal("active"),
      connectedAt: v.number(),
      lastSyncedAt: v.optional(v.number()),
      scopes: v.array(v.string()),
    }),
    v.object({
      state: v.literal("disconnected"),
      connectedAt: v.number(),
      disconnectedAt: v.number(),
      scopes: v.array(v.string()),
    }),
  ),
  handler: async (ctx): Promise<StravaConnectionStatus> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return { state: "none" };
    const row = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!row) return { state: "none" };
    if (row.status === "active") {
      return {
        state: "active",
        connectedAt: row.connectedAt,
        lastSyncedAt: row.lastSyncedAt,
        scopes: supportedStravaScopes(row.scopes),
      };
    }
    return {
      state: "disconnected",
      connectedAt: row.connectedAt,
      disconnectedAt: row.disconnectedAt,
      scopes: supportedStravaScopes(row.scopes),
    };
  },
});
