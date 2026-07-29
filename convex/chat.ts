import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  createThread as agentCreateThread,
  listMessages as listAgentMessages,
  type MessageDoc,
  syncStreams,
  toUIMessages,
  vStreamArgs,
} from "@convex-dev/agent";
import { action, mutation, query, type QueryCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { getEffectiveUserId } from "./lib/auth";
import { buildCoachAgentForStorageOnly } from "./ai/coach";
import { selectApprovalContinuationToolMode } from "./ai/coachTools";
import { rateLimiter } from "./rateLimits";
import { sanitizeTimezone } from "./ai/timeDecay";
import { assertThreadOwnership } from "./chatHelpers";
import { RETRYING_MESSAGE_ERROR } from "./ai/resilienceReporting";
import { getReadyApprovalToolNames, isApprovalStepReady } from "./chatApproval";

const RETRY_LEASE_SCAN_PAGE_SIZE = 50;

async function getActiveRetryingOrders(
  ctx: Pick<QueryCtx, "runQuery">,
  threadId: string,
): Promise<Set<number>> {
  const retryingOrders = new Set<number>();
  let cursor: string | null = null;
  let activeOrder: number | undefined;

  while (true) {
    const result = await listAgentMessages(ctx, components.agent, {
      threadId,
      paginationOpts: { cursor, numItems: RETRY_LEASE_SCAN_PAGE_SIZE },
      statuses: ["success"],
    });
    if (activeOrder === undefined) activeOrder = result.page[0]?.order;
    if (activeOrder === undefined) break;
    const currentOrder = activeOrder;

    for (const message of result.page) {
      if (message.order === currentOrder && message.error === RETRYING_MESSAGE_ERROR) {
        retryingOrders.add(currentOrder);
      }
    }

    if (
      result.isDone ||
      result.page.some((message: MessageDoc) => message.order < currentOrder) ||
      !result.continueCursor ||
      result.continueCursor === cursor
    ) {
      break;
    }
    cursor = result.continueCursor;
  }

  return retryingOrders;
}

export const generateImageUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await rateLimiter.limit(ctx, "imageUpload", { key: userId, throws: true });

    const uploadUrl = await ctx.storage.generateUploadUrl();
    return { uploadUrl };
  },
});

export const createThread = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const threadId = await agentCreateThread(ctx, components.agent, {
      userId,
    });
    return { threadId };
  },
});

/**
 * Creates a new thread and sends the first message. Validates the BYOK key
 * synchronously so key errors surface before the thread is created. The LLM
 * response is scheduled asynchronously (same as sendMessageToThread) so the
 * frontend is never blocked on the full inference roundtrip.
 */
export const createThreadWithMessage = action({
  args: {
    threadId: v.optional(v.string()),
    prompt: v.string(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    userTimezone: v.optional(v.string()),
  },
  handler: async (ctx, { threadId, prompt, imageStorageIds, userTimezone: rawTz }) => {
    const userTimezone = sanitizeTimezone(rawTz);
    const userId = await ctx.runQuery(internal.lib.auth.resolveEffectiveUserId, {});
    if (!userId) throw new Error("Not authenticated");

    // Rate limit: burst + daily cap
    await rateLimiter.limit(ctx, "sendMessage", {
      key: userId,
      throws: true,
    });
    await rateLimiter.limit(ctx, "dailyMessages", {
      key: userId,
      throws: true,
    });

    const staleHours = await ctx.runQuery(internal.userProfiles.getThreadStaleHours, { userId });
    const staleMs = staleHours * 60 * 60 * 1000;

    // Note: we intentionally skip early BYOK validation here. Throwing
    // byok_key_missing from the action surface causes Convex to capture it as
    // an unhandled action failure and report it to Sentry (TONALCOACH-2H). The
    // processMessage scheduled action already handles byok_key_missing via
    // persistScheduledFailure, which writes a user-friendly message directly
    // into the thread. The UX is equivalent and avoids the Sentry noise.

    let targetThreadId: string;
    if (threadId) {
      await assertThreadOwnership(ctx, threadId, userId);
      targetThreadId = threadId;
    } else {
      // Auto-resolve to active thread if not stale
      const active = await ctx.runQuery(internal.threads.getActiveThread, {
        userId,
      });

      if (active && Date.now() - active.lastMessageTime < staleMs) {
        targetThreadId = active.threadId;
      } else {
        // Create new thread (stale or none exists). createThread is the
        // standalone helper from @convex-dev/agent that writes directly
        // into the agent component's storage with no LLM call, so it does
        // not need a per-request agent instance.
        const newThreadId = await agentCreateThread(ctx, components.agent, {
          userId,
        });
        targetThreadId = newThreadId;
      }
    }

    // Schedule the LLM response asynchronously so the frontend gets the
    // threadId back immediately. processMessage handles BYOK resolution,
    // budget checks, streaming, retries, and analytics.
    const scheduledAt = Date.now();
    await ctx.scheduler.runAfter(0, internal.chatProcessing.processMessage, {
      threadId: targetThreadId,
      userId,
      prompt,
      imageStorageIds,
      userTimezone,
      scheduledAt,
    });

    return { threadId: targetThreadId };
  },
});

export const listMessages = query({
  args: {
    threadId: v.string(),
    paginationOpts: paginationOptsValidator,
    streamArgs: vStreamArgs,
  },
  handler: async (ctx, args) => {
    const userId = await getEffectiveUserId(ctx);
    // Return an empty page rather than throwing when auth is not yet established.
    // The subscription re-evaluates once the Convex auth token arrives, so the UI
    // never gets stuck — it briefly shows "no messages" instead of an error.
    if (!userId) {
      return { page: [], isDone: true, continueCursor: "", streams: undefined };
    }
    await assertThreadOwnership(ctx, args.threadId, userId);

    const rawMessages = await listAgentMessages(ctx, components.agent, {
      threadId: args.threadId,
      paginationOpts: args.paginationOpts,
    });
    const retryingOrders = await getActiveRetryingOrders(ctx, args.threadId);
    const visibleMessages = rawMessages.page.filter(
      (message) =>
        !(
          message.status === "failed" &&
          (message.error === RETRYING_MESSAGE_ERROR || message.finishReason === "error")
        ),
    );
    const page = toUIMessages(visibleMessages).map((message) => {
      const isRetrying = retryingOrders.has(message.order);
      if (!isRetrying) return message;
      const metadata =
        message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
          ? message.metadata
          : {};
      return {
        ...message,
        metadata: {
          ...metadata,
          roniTurn: { phase: "retrying" as const },
        },
      };
    });
    const streams = await syncStreams(ctx, components.agent, {
      threadId: args.threadId,
      streamArgs: args.streamArgs,
    });
    return { ...rawMessages, page, streams };
  },
});

export const respondToToolApproval = mutation({
  args: {
    threadId: v.string(),
    approvalId: v.string(),
    approved: v.boolean(),
    reason: v.optional(v.string()),
    userTimezone: v.optional(v.string()),
  },
  handler: async (ctx, { threadId, approvalId, approved, reason, userTimezone: rawTz }) => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await assertThreadOwnership(ctx, threadId, userId);

    // approveToolCall and denyToolCall only write a tool-approval-response
    // message into the agent component's storage. They do not invoke the
    // language model, so we use buildCoachAgentForStorageOnly here, which
    // satisfies the Agent constructor with the server provider but does
    // not (and must not) be used to make any LLM call. The actual LLM
    // continuation happens in the scheduled continueAfterApproval action, which resolves
    // the user's BYOK key the normal way.
    const storageAgent = buildCoachAgentForStorageOnly();

    let messageId: string;
    if (approved) {
      ({ messageId } = await storageAgent.approveToolCall(ctx, {
        threadId,
        approvalId,
        reason,
      }));
    } else {
      ({ messageId } = await storageAgent.denyToolCall(ctx, {
        threadId,
        approvalId,
        reason,
      }));
    }
    const approvalMessages = await storageAgent.listMessages(ctx, {
      threadId,
      paginationOpts: { cursor: null, numItems: 100 },
    });
    const continuationScheduled = isApprovalStepReady(approvalMessages.page, messageId);
    if (continuationScheduled) {
      const toolMode = selectApprovalContinuationToolMode(
        getReadyApprovalToolNames(approvalMessages.page, messageId),
      );
      await ctx.scheduler.runAfter(0, internal.chatProcessing.continueAfterApproval, {
        threadId,
        messageId,
        userId,
        userTimezone: sanitizeTimezone(rawTz),
        toolMode,
      });
    }
    return { messageId, continuationScheduled };
  },
});

/**
 * Appends a message to an existing thread. Schedules the LLM response
 * asynchronously. Use this for all in-thread messages once the thread exists.
 */
export const sendMessageToThread = mutation({
  args: {
    prompt: v.string(),
    threadId: v.string(),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    userTimezone: v.optional(v.string()),
  },
  handler: async (ctx, { prompt, threadId, imageStorageIds, userTimezone: rawTz }) => {
    const userTimezone = sanitizeTimezone(rawTz);
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await assertThreadOwnership(ctx, threadId, userId);

    await rateLimiter.limit(ctx, "sendMessage", {
      key: userId,
      throws: true,
    });
    await rateLimiter.limit(ctx, "dailyMessages", {
      key: userId,
      throws: true,
    });

    const scheduledAt = Date.now();
    await ctx.scheduler.runAfter(0, internal.chatProcessing.processMessage, {
      threadId,
      userId,
      prompt,
      imageStorageIds,
      userTimezone,
      scheduledAt,
    });

    return { threadId };
  },
});
