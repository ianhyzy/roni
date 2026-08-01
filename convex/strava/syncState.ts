import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";

export const recordSyncResult = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    attemptedAt: v.number(),
    result: v.union(
      v.object({
        status: v.literal("success"),
        succeededAt: v.number(),
      }),
      v.object({
        status: v.literal("failure"),
        error: v.string(),
      }),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (!row || row.status !== "active" || row.generation !== args.generation) return false;
    if ((row.lastSyncAttemptAt ?? 0) > args.attemptedAt) return false;
    if (args.result.status === "success") {
      await ctx.db.patch(row._id, {
        lastSyncAttemptAt: args.attemptedAt,
        lastSyncedAt: args.result.succeededAt,
        lastSyncError: undefined,
      });
    } else {
      await ctx.db.patch(row._id, {
        lastSyncAttemptAt: args.attemptedAt,
        lastSyncError: args.result.error,
      });
    }
    return true;
  },
});

export const markProviderDisconnected = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    reason: v.union(v.literal("permission_revoked"), v.literal("token_invalid")),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (!row || row.status !== "active" || row.generation !== args.generation) return false;
    await ctx.db.replace(row._id, {
      userId: row.userId,
      athleteId: row.athleteId,
      generation: row.generation,
      status: "disconnected",
      scopes: row.scopes,
      connectedAt: row.connectedAt,
      disconnectedAt: args.now,
      disconnectReason: args.reason,
    });
    await ctx.scheduler.runAfter(0, internal.strava.activityPersistence.purgeGeneration, {
      userId: args.userId,
      generation: args.generation,
    });
    return true;
  },
});
