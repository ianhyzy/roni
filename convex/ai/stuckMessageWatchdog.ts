import { v } from "convex/values";
import { components } from "../_generated/api";
import { internalMutation, type MutationCtx } from "../_generated/server";

// Convex actions are hard-killed at 600s. When a coach turn's generating action
// dies before it can finalize (OOM, the 600s cap, or a hung tool call that
// outlives the in-stream abort), its assistant message is left in a non-terminal
// state forever. The chat UI renders an empty, non-failed assistant message as a
// perpetual "generating" spinner (see ChatThread's `lastIsAssistantWithoutText`),
// so users report the coach "stuck generating" for days. @convex-dev/agent's own
// stream timeout reaps the streaming row but never the persisted message, and no
// cron does either. This watchdog, scheduled once per turn, fails any message
// left non-terminal past the action lifetime so the UI can recover.

// Convex caps action lifetime at 600s. The action that owns a message starts no
// later than that message's creation, so the owner is guaranteed dead once the
// message has been non-terminal for longer than this cap.
export const CONVEX_ACTION_MAX_MS = 10 * 60 * 1000;

// A message non-terminal longer than this can no longer have a live action
// working on it (action cap + jitter buffer), so failing it can never race a
// live turn.
export const STUCK_MESSAGE_GRACE_MS = CONVEX_ACTION_MAX_MS + 60 * 1000;

// Delay before the per-turn sweep runs. A turn's retry path (up to 3 × 180s
// attempts) can create the assistant row for its final attempt late in the
// action's life — up to ~CONVEX_ACTION_MAX_MS after this timer starts. The delay
// must therefore exceed the grace window plus the action cap, so that even such a
// late-created row has aged past the grace window when the single per-turn sweep
// fires. Otherwise the sweep would see it as too new, skip it, and queue no later
// sweep — stranding it (and the "generating" spinner) indefinitely.
export const STUCK_MESSAGE_WATCHDOG_DELAY_MS =
  STUCK_MESSAGE_GRACE_MS + CONVEX_ACTION_MAX_MS + 60 * 1000;

const STUCK_MESSAGE_REASON = "stuck_timeout";
const STUCK_MESSAGE_SWEEP_PAGE_SIZE = 50;

/**
 * Finalize messages in a thread that have been stuck in a non-terminal state
 * longer than the grace window. Returns the number finalized. Messages newer
 * than the cutoff are left untouched so an in-flight turn is never interrupted.
 */
export async function finalizeStuckThreadMessages(
  ctx: Pick<MutationCtx, "runQuery" | "runMutation">,
  threadId: string,
  now: number,
): Promise<number> {
  const cutoff = now - STUCK_MESSAGE_GRACE_MS;
  const result = await ctx.runQuery(components.agent.messages.listMessagesByThreadId, {
    threadId,
    paginationOpts: { cursor: null, numItems: STUCK_MESSAGE_SWEEP_PAGE_SIZE },
    order: "desc",
  });
  let finalized = 0;
  for (const message of result.page) {
    if (message.status === "success" || message.status === "failed") continue;
    if (message._creationTime >= cutoff) continue;
    await ctx.runMutation(components.agent.messages.finalizeMessage, {
      messageId: message._id,
      result: { status: "failed", error: STUCK_MESSAGE_REASON },
    });
    finalized++;
  }
  return finalized;
}

/**
 * Scheduled once per turn: finalize this thread's messages left non-terminal
 * past the grace window so a killed generating action cannot strand the chat
 * on "generating". A no-op when the turn finished normally.
 */
export const finalizeStuckMessagesForThread = internalMutation({
  args: { threadId: v.string() },
  handler: async (ctx, { threadId }): Promise<null> => {
    await finalizeStuckThreadMessages(ctx, threadId, Date.now());
    return null;
  },
});
