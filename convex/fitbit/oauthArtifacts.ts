import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { isDeletionInProgress } from "../lib/auth";

const OAUTH_ARTIFACT_TTL_MS = 15 * 60 * 1000;
const OAUTH_SWEEP_BATCH_SIZE = 100;

export const saveOauthState = internalMutation({
  args: { userId: v.id("users"), stateHash: v.string(), now: v.number() },
  handler: async (ctx, { userId, stateHash, now }) => {
    if (await isDeletionInProgress(ctx, userId)) {
      throw new Error("Account deletion is in progress");
    }
    const existing = await ctx.db
      .query("fitbitOauthStates")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .take(5);
    for (const row of existing) await ctx.db.delete(row._id);
    return ctx.db.insert("fitbitOauthStates", {
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
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query("fitbitOauthStates")
      .withIndex("by_stateHash", (q) => q.eq("stateHash", args.stateHash))
      .unique();
    if (!state || state.expiresAt <= args.now) return false;

    await ctx.db.delete(state._id);
    const existingTickets = await ctx.db
      .query("fitbitOauthCallbackTickets")
      .withIndex("by_userId", (q) => q.eq("userId", state.userId))
      .take(5);
    for (const row of existingTickets) await ctx.db.delete(row._id);
    await ctx.db.insert("fitbitOauthCallbackTickets", {
      userId: state.userId,
      ticketHash: args.ticketHash,
      authorizationCodeEncrypted: args.authorizationCodeEncrypted,
      createdAt: args.now,
      expiresAt: args.now + OAUTH_ARTIFACT_TTL_MS,
    });
    return true;
  },
});

export const claimOauthCallbackTicket = internalMutation({
  args: { userId: v.id("users"), ticketHash: v.string(), now: v.number() },
  handler: async (ctx, { userId, ticketHash, now }) => {
    const row = await ctx.db
      .query("fitbitOauthCallbackTickets")
      .withIndex("by_ticketHash", (q) => q.eq("ticketHash", ticketHash))
      .unique();
    if (!row || row.userId !== userId || row.expiresAt <= now) return null;
    await ctx.db.delete(row._id);
    return row.authorizationCodeEncrypted;
  },
});

export const sweepExpired = internalMutation({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const [states, tickets] = await Promise.all([
      ctx.db
        .query("fitbitOauthStates")
        .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
        .take(OAUTH_SWEEP_BATCH_SIZE),
      ctx.db
        .query("fitbitOauthCallbackTickets")
        .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
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
