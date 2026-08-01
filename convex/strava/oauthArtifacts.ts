import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { isDeletionInProgress } from "../lib/auth";

const OAUTH_ARTIFACT_TTL_MS = 15 * 60 * 1000;
const OAUTH_COMPLETION_LEASE_MS = 2 * 60 * 1000;
const OAUTH_SWEEP_BATCH_SIZE = 100;
const MAX_OUTSTANDING_ARTIFACTS_PER_USER = 5;

export const saveOauthState = internalMutation({
  args: { userId: v.id("users"), stateHash: v.string(), now: v.number() },
  returns: v.id("stravaOauthStates"),
  handler: async (ctx, { userId, stateHash, now }) => {
    if (await isDeletionInProgress(ctx, userId)) {
      throw new Error("Account deletion is in progress");
    }
    const existing = await ctx.db
      .query("stravaOauthStates")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(MAX_OUTSTANDING_ARTIFACTS_PER_USER);
    for (const row of existing) await ctx.db.delete(row._id);
    return ctx.db.insert("stravaOauthStates", {
      userId,
      stateHash,
      createdAt: now,
      expiresAt: now + OAUTH_ARTIFACT_TTL_MS,
    });
  },
});

export const exchangeOauthStateForTicket = internalMutation({
  args: {
    stateHash: v.string(),
    ticketHash: v.string(),
    authorizationCodeEncrypted: v.string(),
    acceptedScopes: v.array(v.string()),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("stravaOauthStates")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (!state) return false;

    // Consume the state even when expired so every callback artifact is single-use.
    await ctx.db.delete(state._id);
    if (state.expiresAt <= args.now) return false;

    const existingTickets = await ctx.db
      .query("stravaOauthCallbackTickets")
      .withIndex("by_userId", (q) => q.eq("userId", state.userId))
      .take(MAX_OUTSTANDING_ARTIFACTS_PER_USER);
    if (existingTickets.some((row) => row.completionNonce && row.expiresAt > args.now)) {
      return false;
    }
    for (const row of existingTickets) await ctx.db.delete(row._id);
    await ctx.db.insert("stravaOauthCallbackTickets", {
      userId: state.userId,
      ticketHash: args.ticketHash,
      authorizationCodeEncrypted: args.authorizationCodeEncrypted,
      acceptedScopes: args.acceptedScopes,
      createdAt: args.now,
      expiresAt: args.now + OAUTH_ARTIFACT_TTL_MS,
    });
    return true;
  },
});

export const claimOauthCallbackTicket = internalMutation({
  args: {
    userId: v.id("users"),
    ticketHash: v.string(),
    completionNonce: v.string(),
    now: v.number(),
  },
  returns: v.union(
    v.null(),
    v.object({
      state: v.literal("active"),
    }),
    v.object({
      state: v.literal("claimed"),
      artifact: v.object({
        authorizationCodeEncrypted: v.string(),
        acceptedScopes: v.array(v.string()),
      }),
    }),
  ),
  handler: async (ctx, { userId, ticketHash, completionNonce, now }) => {
    const row = await ctx.db
      .query("stravaOauthCallbackTickets")
      .withIndex("by_ticketHash", (q) => q.eq("ticketHash", ticketHash))
      .unique();
    if (!row || row.userId !== userId || row.completionNonce) return null;

    if (row.expiresAt <= now) {
      await ctx.db.delete(row._id);
      return null;
    }
    const connection = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (connection?.status === "active") {
      await ctx.db.delete(row._id);
      return { state: "active" as const };
    }
    await ctx.db.patch(row._id, {
      completionNonce,
      expiresAt: now + OAUTH_COMPLETION_LEASE_MS,
    });
    return {
      state: "claimed" as const,
      artifact: {
        authorizationCodeEncrypted: row.authorizationCodeEncrypted,
        acceptedScopes: row.acceptedScopes,
      },
    };
  },
});

export const releaseOauthCallbackTicket = internalMutation({
  args: {
    userId: v.id("users"),
    ticketHash: v.string(),
    completionNonce: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, { userId, ticketHash, completionNonce }) => {
    const claimed = await ctx.db
      .query("stravaOauthCallbackTickets")
      .withIndex("by_ticketHash", (q) => q.eq("ticketHash", ticketHash))
      .unique();
    if (!claimed || claimed.userId !== userId || claimed.completionNonce !== completionNonce) {
      return false;
    }
    await ctx.db.delete(claimed._id);
    return true;
  },
});

export const sweepExpired = internalMutation({
  args: { now: v.number() },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, { now }) => {
    const [states, tickets] = await Promise.all([
      ctx.db
        .query("stravaOauthStates")
        .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
        .take(OAUTH_SWEEP_BATCH_SIZE),
      ctx.db
        .query("stravaOauthCallbackTickets")
        .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
        .take(OAUTH_SWEEP_BATCH_SIZE),
    ]);
    for (const row of [...states, ...tickets]) await ctx.db.delete(row._id);
    return {
      deleted: states.length + tickets.length,
      hasMore:
        states.length === OAUTH_SWEEP_BATCH_SIZE || tickets.length === OAUTH_SWEEP_BATCH_SIZE,
    };
  },
});
