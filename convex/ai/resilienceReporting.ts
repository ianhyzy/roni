import type { ActionCtx } from "../_generated/server";
import { components, internal } from "../_generated/api";
import { saveMessage } from "@convex-dev/agent";
import { buildByokErrorMessage, classifyByokError } from "./byokErrors";
import type { ProviderId } from "./providers";
import { buildProviderTransientMessage, classifyTransientError } from "./transientErrors";

const AI_ERROR_MESSAGE = "I'm having trouble right now. Please try again in a moment.";
const PENDING_MESSAGE_PAGE_SIZE = 50;
const SAFE_ERROR_CODES = new Set([
  "AbortError",
  "Error",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TimeoutError",
  "TypeError",
  "byok_key_invalid",
  "byok_quota_exceeded",
  "byok_safety_blocked",
  "byok_unknown_error",
  "context_limit",
  "network",
  "provider_overload",
  "rate_limit",
  "server_error",
  "timeout",
  "unexpected_error",
  "unknown_error",
]);
export const RETRYING_MESSAGE_ERROR = "transient_retry";
export const RETRY_FINISHED_MESSAGE_ERROR = "retry_finished";

export interface AgentTurnRef {
  threadId: string;
  promptMessageId: string;
}

export interface ErrorReport extends AgentTurnRef {
  userId: string;
  error: unknown;
  isByok: boolean;
  provider: ProviderId;
}

async function getTurnAnchor(ctx: Pick<ActionCtx, "runQuery">, turnRef: AgentTurnRef) {
  const [anchor] = await ctx.runQuery(components.agent.messages.getMessagesByIds, {
    messageIds: [turnRef.promptMessageId],
  });
  return anchor?.threadId === turnRef.threadId ? anchor : null;
}

async function listMessagesForTurn(
  ctx: Pick<ActionCtx, "runQuery">,
  turnRef: AgentTurnRef,
  pageSize: number,
  statuses: Array<"pending" | "success" | "failed">,
) {
  const anchor = await getTurnAnchor(ctx, turnRef);
  if (!anchor) return [];

  const messages: Array<typeof anchor> = [];
  let cursor: string | null = null;
  while (true) {
    const result: {
      page: Array<typeof anchor>;
      isDone: boolean;
      continueCursor: string;
    } = await ctx.runQuery(components.agent.messages.listMessagesByThreadId, {
      threadId: turnRef.threadId,
      upToAndIncludingMessageId: turnRef.promptMessageId,
      paginationOpts: { cursor, numItems: pageSize },
      order: "desc",
      statuses,
    });
    messages.push(...result.page.filter((message) => message.order === anchor.order));

    if (
      result.isDone !== false ||
      result.page.some((message) => message.order < anchor.order) ||
      !result.continueCursor ||
      result.continueCursor === cursor
    ) {
      break;
    }
    cursor = result.continueCursor;
  }

  if (
    statuses.some((status) => status === anchor.status) &&
    !messages.some((message) => message._id === anchor._id)
  ) {
    messages.push(anchor);
  }
  return messages;
}

export async function listPendingMessagesForTurn(
  ctx: Pick<ActionCtx, "runQuery">,
  turnRef: AgentTurnRef,
  pageSize: number,
) {
  const messages = await listMessagesForTurn(ctx, turnRef, pageSize, ["pending"]);
  return messages.filter((message) => message.status === "pending");
}

export async function listRetryingMessagesForTurn(
  ctx: Pick<ActionCtx, "runQuery">,
  turnRef: AgentTurnRef,
) {
  const anchor = await getTurnAnchor(ctx, turnRef);
  return anchor?.error === RETRYING_MESSAGE_ERROR ? [anchor] : [];
}

export async function markTurnRetrying(ctx: ActionCtx, turnRef: AgentTurnRef): Promise<void> {
  const promptMessage = await getTurnAnchor(ctx, turnRef);
  if (!promptMessage) throw new Error("retry_marker_missing");
  if (promptMessage.error === RETRYING_MESSAGE_ERROR) return;

  await ctx.runMutation(components.agent.messages.updateMessage, {
    messageId: promptMessage._id,
    patch: { error: RETRYING_MESSAGE_ERROR },
  });
}

export async function clearTurnRetrying(
  ctx: ActionCtx,
  turnRef: AgentTurnRef,
  reason: string = RETRY_FINISHED_MESSAGE_ERROR,
): Promise<void> {
  const [retryingMessage] = await listRetryingMessagesForTurn(ctx, turnRef);
  if (!retryingMessage) return;
  await ctx.runMutation(components.agent.messages.updateMessage, {
    messageId: retryingMessage._id,
    patch: { error: reason },
  });
}

export async function markFailedTurnMessagesAsSuperseded(
  ctx: ActionCtx,
  turnRef: AgentTurnRef,
): Promise<void> {
  const failedMessages = await listMessagesForTurn(ctx, turnRef, PENDING_MESSAGE_PAGE_SIZE, [
    "failed",
  ]);
  for (const message of failedMessages) {
    if (message._id === turnRef.promptMessageId || message.error === RETRYING_MESSAGE_ERROR) {
      continue;
    }
    await ctx.runMutation(components.agent.messages.updateMessage, {
      messageId: message._id,
      patch: { error: RETRYING_MESSAGE_ERROR },
    });
  }
}

// streamText's abortSignal handler finalizes on clean aborts; provider errors
// thrown from result.text bypass that path and leave a stranded pending row.
export async function finalizePendingMessages(
  ctx: ActionCtx,
  turnRef: AgentTurnRef,
  reason: string,
): Promise<void> {
  const pendingMessages = await listPendingMessagesForTurn(ctx, turnRef, PENDING_MESSAGE_PAGE_SIZE);
  for (const message of pendingMessages) {
    // Bypass finalizeMessage because replaying an error delta aborts its status update.
    await ctx.runMutation(components.agent.messages.updateMessage, {
      messageId: message._id,
      patch: { status: "failed", error: reason },
    });
  }
}

export function getFinalizeCodeForError(error: unknown): string {
  const transientKind = classifyTransientError(error);
  return (
    transientKind ?? (error instanceof Error ? sanitizeErrorCode(error.name) : "unknown_error")
  );
}

export function sanitizeErrorCode(value: unknown): string {
  return typeof value === "string" && SAFE_ERROR_CODES.has(value) ? value : "unexpected_error";
}

// Best-effort wrappers must not leave users with stuck pending messages.
export const safeFinalizePending = (ctx: ActionCtx, turnRef: AgentTurnRef, reason: string) =>
  finalizePendingMessages(ctx, turnRef, reason).catch(() => undefined);
export const safeMarkFailedTurnMessagesAsSuperseded = (ctx: ActionCtx, turnRef: AgentTurnRef) =>
  markFailedTurnMessagesAsSuperseded(ctx, turnRef).catch(() => undefined);
export const safeReportError = (ctx: ActionCtx, report: ErrorReport) =>
  reportError(ctx, report).catch(() => undefined);
export const safeTryReportByok = (ctx: ActionCtx, report: ErrorReport) =>
  tryReportByok(ctx, report).catch(() => false);

async function scheduleErrorNotification(
  ctx: ActionCtx,
  notification: { source: string; message: string; userId: string },
): Promise<void> {
  try {
    await ctx.scheduler.runAfter(0, internal.discord.notifyError, notification);
  } catch {
    // Optional alerting must not change the terminal response persisted for the user.
  }
}

async function tryReportByok(ctx: ActionCtx, report: ErrorReport): Promise<boolean> {
  if (!report.isByok) return false;
  const code = classifyByokError(report.error);
  if (code === null) return false;
  await saveMessage(ctx, components.agent, {
    threadId: report.threadId,
    promptMessageId: report.promptMessageId,
    userId: report.userId,
    message: { role: "assistant", content: buildByokErrorMessage(code, report.provider) },
  });
  await scheduleErrorNotification(ctx, {
    source: "streamWithRetry",
    message: `${code} on ${report.provider}`,
    userId: report.userId,
  });
  return true;
}

async function reportError(ctx: ActionCtx, report: ErrorReport): Promise<void> {
  const transientKind = classifyTransientError(report.error);
  const content = transientKind
    ? buildProviderTransientMessage(transientKind, report.provider, report.isByok)
    : AI_ERROR_MESSAGE;

  await saveMessage(ctx, components.agent, {
    threadId: report.threadId,
    promptMessageId: report.promptMessageId,
    userId: report.userId,
    message: { role: "assistant", content },
  });

  // Upstream provider outages already surface to the user with an attributed
  // message; paging Discord on every Gemini/Claude capacity blip is noise.
  if (transientKind) return;

  await scheduleErrorNotification(ctx, {
    source: "streamWithRetry",
    message: `${getFinalizeCodeForError(report.error)} on ${report.provider}`,
    userId: report.userId,
  });
}
