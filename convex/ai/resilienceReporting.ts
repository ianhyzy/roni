import type { ActionCtx } from "../_generated/server";
import { components, internal } from "../_generated/api";
import { saveMessage } from "@convex-dev/agent";
import { buildByokErrorMessage, classifyByokError } from "./byokErrors";
import type { ProviderId } from "./providers";
import { buildProviderTransientMessage, classifyTransientError } from "./transientErrors";

const AI_ERROR_MESSAGE = "I'm having trouble right now. Please try again in a moment.";

export interface ErrorReport {
  threadId: string;
  userId: string;
  error: unknown;
  isByok: boolean;
  provider: ProviderId;
}

// streamText's abortSignal handler finalizes on clean aborts; provider errors
// thrown from result.text bypass that path and leave a stranded pending row.
export async function finalizePendingMessages(
  ctx: ActionCtx,
  threadId: string,
  reason: string,
): Promise<void> {
  const result = await ctx.runQuery(components.agent.messages.listMessagesByThreadId, {
    threadId,
    paginationOpts: { cursor: null, numItems: 50 },
    order: "desc",
  });
  for (const message of result.page) {
    if (message.status !== "pending") continue;
    await ctx.runMutation(components.agent.messages.finalizeMessage, {
      messageId: message._id,
      result: { status: "failed", error: reason },
    });
  }
}

export function getFinalizeCodeForError(error: unknown): string {
  const transientKind = classifyTransientError(error);
  return transientKind ?? (error instanceof Error ? error.name : "unknown_error");
}

// Best-effort wrappers must not leave users with stuck pending messages.
export const safeFinalizePending = (ctx: ActionCtx, threadId: string, reason: string) =>
  finalizePendingMessages(ctx, threadId, reason).catch(() => undefined);
export const safeReportError = (ctx: ActionCtx, report: ErrorReport) =>
  reportError(ctx, report).catch(() => undefined);
export const safeTryReportByok = (ctx: ActionCtx, report: ErrorReport) =>
  tryReportByok(ctx, report).catch(() => false);

async function tryReportByok(ctx: ActionCtx, report: ErrorReport): Promise<boolean> {
  if (!report.isByok) return false;
  const code = classifyByokError(report.error);
  if (code === null) return false;
  // Provider bodies can include the decrypted key, so the finalize reason is the code only.
  await finalizePendingMessages(ctx, report.threadId, code);
  await saveMessage(ctx, components.agent, {
    threadId: report.threadId,
    userId: report.userId,
    message: { role: "assistant", content: buildByokErrorMessage(code, report.provider) },
  });
  await ctx.runAction(internal.discord.notifyError, {
    source: "streamWithRetry",
    message: `${code} on ${report.provider} (${report.error instanceof Error ? report.error.name : "Unknown"})`,
    userId: report.userId,
  });
  return true;
}

async function reportError(ctx: ActionCtx, report: ErrorReport): Promise<void> {
  const transientKind = classifyTransientError(report.error);
  const content = transientKind
    ? buildProviderTransientMessage(transientKind, report.provider, report.isByok)
    : AI_ERROR_MESSAGE;

  // Keep provider text out of the agent component's failed-message field.
  await finalizePendingMessages(ctx, report.threadId, getFinalizeCodeForError(report.error));

  await saveMessage(ctx, components.agent, {
    threadId: report.threadId,
    userId: report.userId,
    message: { role: "assistant", content },
  });

  // Upstream provider outages already surface to the user with an attributed
  // message; paging Discord on every Gemini/Claude capacity blip is noise.
  if (transientKind) return;

  const reason = report.error instanceof Error ? report.error.message : String(report.error);
  await ctx.runAction(internal.discord.notifyError, {
    source: "streamWithRetry",
    message: reason,
    userId: report.userId,
  });
}
