import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery } from "../_generated/server";
import { isDeletionInProgress } from "../lib/auth";
import { STRAVA_REQUIRED_SCOPE, supportedStravaScopes } from "./config";

const disconnectReasonValidator = v.union(
  v.literal("user_disconnected"),
  v.literal("permission_revoked"),
  v.literal("token_invalid"),
  v.literal("account_deleted"),
);
const privateActiveConnectionValidator = v.object({
  userId: v.id("users"),
  athleteId: v.string(),
  generation: v.string(),
  accessTokenEncrypted: v.string(),
  refreshTokenEncrypted: v.string(),
  tokenExpiresAt: v.number(),
  scopes: v.array(v.string()),
  connectedAt: v.number(),
  refreshLeaseNonce: v.optional(v.string()),
  refreshLeaseExpiresAt: v.optional(v.number()),
});

export const getActiveConnectionByUserId = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.null(), privateActiveConnectionValidator),
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!row || row.status !== "active") return null;
    return {
      userId: row.userId,
      athleteId: row.athleteId,
      generation: row.generation,
      accessTokenEncrypted: row.accessTokenEncrypted,
      refreshTokenEncrypted: row.refreshTokenEncrypted,
      tokenExpiresAt: row.tokenExpiresAt,
      scopes: row.scopes,
      connectedAt: row.connectedAt,
      refreshLeaseNonce: row.refreshLeaseNonce,
      refreshLeaseExpiresAt: row.refreshLeaseExpiresAt,
    };
  },
});

export const upsertActiveConnection = internalMutation({
  args: {
    userId: v.id("users"),
    athleteId: v.string(),
    generation: v.string(),
    accessTokenEncrypted: v.string(),
    refreshTokenEncrypted: v.string(),
    tokenExpiresAt: v.number(),
    scopes: v.array(v.string()),
    refreshDueAt: v.number(),
    now: v.number(),
  },
  returns: v.object({
    connectionId: v.id("stravaConnections"),
    replacedGeneration: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    if (await isDeletionInProgress(ctx, args.userId)) {
      throw new Error("Account deletion is in progress");
    }
    const activeForAthlete = await ctx.db
      .query("stravaConnections")
      .withIndex("by_athleteId_and_status", (q) =>
        q.eq("athleteId", args.athleteId).eq("status", "active"),
      )
      .take(2);
    if (activeForAthlete.some((row) => row.userId !== args.userId)) {
      throw new Error("This Strava account is already connected to another Roni account");
    }

    const existing = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (existing?.status === "active") {
      if (existing.athleteId === args.athleteId) {
        throw new Error("This Strava account is already connected to your Roni account");
      }
      throw new Error("Disconnect your current Strava account before connecting another");
    }
    const scopes = supportedStravaScopes(args.scopes);
    if (!scopes.includes(STRAVA_REQUIRED_SCOPE)) {
      throw new Error("Strava activity read access is required");
    }
    const active = {
      userId: args.userId,
      athleteId: args.athleteId,
      generation: args.generation,
      status: "active" as const,
      accessTokenEncrypted: args.accessTokenEncrypted,
      refreshTokenEncrypted: args.refreshTokenEncrypted,
      tokenExpiresAt: args.tokenExpiresAt,
      scopes,
      connectedAt: args.now,
      refreshDueAt: args.refreshDueAt,
    };
    let connectionId;
    let replacedGeneration: string | undefined;
    if (existing) {
      await ctx.db.replace(existing._id, active);
      connectionId = existing._id;
      replacedGeneration = existing.generation;
    } else {
      connectionId = await ctx.db.insert("stravaConnections", active);
    }
    await ctx.scheduler.runAfter(0, internal.strava.sync.runInitialSync, {
      userId: args.userId,
      athleteId: args.athleteId,
      generation: args.generation,
      attempt: 1,
    });
    return { connectionId, ...(replacedGeneration ? { replacedGeneration } : {}) };
  },
});

export const acquireRefreshLease = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    expectedTokenExpiresAt: v.number(),
    leaseNonce: v.string(),
    now: v.number(),
    leaseExpiresAt: v.number(),
  },
  returns: v.union(
    v.object({ state: v.literal("changed") }),
    v.object({ state: v.literal("leased"), retryAfterMs: v.number() }),
    v.object({ state: v.literal("acquired"), refreshTokenEncrypted: v.string() }),
  ),
  handler: async (ctx, args) => {
    if (await isDeletionInProgress(ctx, args.userId)) {
      return { state: "changed" as const };
    }
    const row = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (
      !row ||
      row.status !== "active" ||
      row.generation !== args.generation ||
      row.tokenExpiresAt !== args.expectedTokenExpiresAt
    ) {
      return { state: "changed" as const };
    }
    if (row.refreshLeaseNonce && (row.refreshLeaseExpiresAt ?? 0) > args.now) {
      return {
        state: "leased" as const,
        retryAfterMs: row.refreshLeaseExpiresAt! - args.now,
      };
    }
    await ctx.db.patch(row._id, {
      refreshLeaseNonce: args.leaseNonce,
      refreshLeaseExpiresAt: args.leaseExpiresAt,
    });
    return { state: "acquired" as const, refreshTokenEncrypted: row.refreshTokenEncrypted };
  },
});

export const persistRefreshedTokens = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    expectedTokenExpiresAt: v.number(),
    leaseNonce: v.string(),
    accessTokenEncrypted: v.string(),
    refreshTokenEncrypted: v.string(),
    tokenExpiresAt: v.number(),
    refreshDueAt: v.number(),
  },
  returns: v.union(
    v.object({ state: v.literal("persisted") }),
    v.object({ state: v.literal("changed") }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (
      !row ||
      row.status !== "active" ||
      row.generation !== args.generation ||
      row.tokenExpiresAt !== args.expectedTokenExpiresAt ||
      row.refreshLeaseNonce !== args.leaseNonce
    ) {
      return { state: "changed" as const };
    }
    await ctx.db.patch(row._id, {
      accessTokenEncrypted: args.accessTokenEncrypted,
      refreshTokenEncrypted: args.refreshTokenEncrypted,
      tokenExpiresAt: args.tokenExpiresAt,
      refreshDueAt: args.refreshDueAt,
      refreshLeaseNonce: undefined,
      refreshLeaseExpiresAt: undefined,
    });
    return { state: "persisted" as const };
  },
});

export const releaseRefreshLease = internalMutation({
  args: { userId: v.id("users"), generation: v.string(), leaseNonce: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (
      !row ||
      row.status !== "active" ||
      row.generation !== args.generation ||
      row.refreshLeaseNonce !== args.leaseNonce
    ) {
      return false;
    }
    await ctx.db.patch(row._id, {
      refreshLeaseNonce: undefined,
      refreshLeaseExpiresAt: undefined,
    });
    return true;
  },
});

export const abandonRefresh = internalMutation({
  args: {
    userId: v.id("users"),
    generation: v.string(),
    expectedTokenExpiresAt: v.number(),
    leaseNonce: v.string(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (
      !row ||
      row.status !== "active" ||
      row.generation !== args.generation ||
      row.tokenExpiresAt !== args.expectedTokenExpiresAt ||
      row.refreshLeaseNonce !== args.leaseNonce
    ) {
      return false;
    }
    await ctx.db.replace(row._id, {
      userId: row.userId,
      athleteId: row.athleteId,
      generation: row.generation,
      status: "disconnected",
      scopes: row.scopes,
      connectedAt: row.connectedAt,
      disconnectedAt: args.now,
      disconnectReason: "token_invalid",
    });
    return true;
  },
});

export const claimDisconnect = internalMutation({
  args: {
    userId: v.id("users"),
    reason: disconnectReasonValidator,
    now: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      state: v.literal("leased"),
      retryAfterMs: v.number(),
    }),
    v.object({
      state: v.literal("claimed"),
      generation: v.string(),
      accessTokenEncrypted: v.string(),
    }),
  ),
  handler: async (ctx, { userId, reason, now }) => {
    const tickets = await ctx.db
      .query("stravaOauthCallbackTickets")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(5);
    const completion = tickets.find((ticket) => ticket.completionNonce && ticket.expiresAt > now);
    if (completion) {
      return {
        state: "leased" as const,
        retryAfterMs: completion.expiresAt - now,
      };
    }
    for (const ticket of tickets) await ctx.db.delete(ticket._id);
    const states = await ctx.db
      .query("stravaOauthStates")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(5);
    for (const state of states) await ctx.db.delete(state._id);

    const row = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!row || row.status !== "active") return null;
    if (row.refreshLeaseNonce && (row.refreshLeaseExpiresAt ?? 0) > now) {
      return {
        state: "leased" as const,
        retryAfterMs: row.refreshLeaseExpiresAt! - now,
      };
    }

    const claimed = {
      state: "claimed" as const,
      generation: row.generation,
      accessTokenEncrypted: row.accessTokenEncrypted,
    };
    await ctx.db.replace(row._id, {
      userId,
      athleteId: row.athleteId,
      generation: row.generation,
      status: "disconnected",
      scopes: row.scopes,
      connectedAt: row.connectedAt,
      disconnectedAt: now,
      disconnectReason: reason,
    });
    await ctx.scheduler.runAfter(0, internal.strava.activityPersistence.purgeGeneration, {
      userId,
      generation: row.generation,
    });
    return claimed;
  },
});
