import { internalAction, internalQuery, query } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { v } from "convex/values";
import { getEffectiveUserId } from "./lib/auth";

/**
 * Internal query: find the user's most recent active thread
 * and its last message timestamp.
 * Called by createThreadWithMessage action via ctx.runQuery.
 */
export const getActiveThread = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const threads = await ctx.runQuery(components.agent.threads.listThreadsByUserId, {
      userId: userId as string,
      paginationOpts: { cursor: null, numItems: 1 },
      order: "desc",
    });

    const thread = threads.page[0];
    if (!thread || thread.status !== "active") return null;

    const messages = await ctx.runQuery(components.agent.messages.listMessagesByThreadId, {
      threadId: thread._id,
      paginationOpts: { cursor: null, numItems: 1 },
      order: "desc",
    });

    const lastMessageTime = messages.page[0]?._creationTime ?? thread._creationTime;

    return { threadId: thread._id, lastMessageTime };
  },
});

/**
 * Public query: client subscribes to this to get the active thread ID.
 * Returns null if no active thread exists.
 */
export const getCurrentThread = query({
  args: {},
  handler: async (ctx): Promise<{ threadId: string; lastMessageTime: number } | null> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return null;

    return ctx.runQuery(internal.threads.getActiveThread, { userId });
  },
});

/**
 * Public query: loads messages from threads older than the current one.
 * Used for "Load earlier" in the continuous scroll.
 */
export const listConversationHistory = query({
  args: {
    beforeThreadId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { beforeThreadId, limit = 20 }) => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return { messages: [], hasMore: false };

    const threads = await ctx.runQuery(components.agent.threads.listThreadsByUserId, {
      userId: userId as string,
      paginationOpts: { cursor: null, numItems: 50 },
      order: "desc",
    });

    let foundCurrent = !beforeThreadId;
    const olderThreads = [];
    for (const thread of threads.page) {
      if (thread._id === beforeThreadId) {
        foundCurrent = true;
        continue;
      }
      if (foundCurrent && thread.status === "active") {
        olderThreads.push(thread);
      }
    }

    if (olderThreads.length === 0) return { messages: [], hasMore: false };

    const targetThread = olderThreads[0];
    const result = await ctx.runQuery(components.agent.messages.listMessagesByThreadId, {
      threadId: targetThread._id,
      paginationOpts: { cursor: null, numItems: limit },
      order: "asc",
    });

    return {
      messages: result.page,
      threadId: targetThread._id,
      hasMore: olderThreads.length > 1 || !result.isDone,
    };
  },
});

/**
 * Internal: one page of user IDs, for batch admin sweeps over all users.
 */
export const listUserIdsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const result = await ctx.db.query("users").paginate({ cursor, numItems: 200 });
    return {
      userIds: result.page.map((u) => u._id as string),
      cursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

/**
 * One-off admin sweep: archive each user's current (most-recent active) chat
 * thread so their next message starts a fresh thread via createThreadWithMessage
 * (the stale/none path). Internal-only; run from the Convex dashboard or CLI:
 *   npx convex run --prod threads:rollAllActiveThreads '{"dryRun":true}'  # count only
 *   npx convex run --prod threads:rollAllActiveThreads                    # execute
 * Messages are not deleted — status flips to "archived" (reversible) — but the
 * rolled conversation drops out of the user's view; they start fresh.
 */
export const rollAllActiveThreads = internalAction({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { dryRun = false },
  ): Promise<{ usersScanned: number; threadsRolled: number; dryRun: boolean }> => {
    let usersScanned = 0;
    let threadsRolled = 0;
    let cursor: string | null = null;

    for (;;) {
      const page: { userIds: string[]; cursor: string; isDone: boolean } = await ctx.runQuery(
        internal.threads.listUserIdsPage,
        { cursor },
      );
      for (const userId of page.userIds) {
        usersScanned++;
        const threads = await ctx.runQuery(components.agent.threads.listThreadsByUserId, {
          userId,
          paginationOpts: { cursor: null, numItems: 1 },
          order: "desc",
        });
        const current = threads.page[0];
        if (!current || current.status !== "active") continue;
        if (!dryRun) {
          await ctx.runMutation(components.agent.threads.updateThread, {
            threadId: current._id,
            patch: { status: "archived" },
          });
        }
        threadsRolled++;
      }
      if (page.isDone) break;
      cursor = page.cursor;
    }

    return { usersScanned, threadsRolled, dryRun };
  },
});
