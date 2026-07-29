import type { UIMessage } from "@convex-dev/agent/react";

type CoachActivity = "preparing" | "tool" | "responding";

export type CoachTurnState =
  | { status: "idle" }
  | { status: "submitting"; startedAt: number }
  | { status: "working"; activity: CoachActivity; startedAt: number }
  | { status: "retrying"; activity: CoachActivity; startedAt: number }
  | { status: "awaiting-approval"; startedAt: number }
  | { status: "failed"; reason: "response" | "expired"; failedAt: number }
  | { status: "complete"; completedAt: number };

export const MAX_ACTIVE_TURN_AGE_MS = 22 * 60 * 1000;

function expireActiveState(
  state: Extract<CoachTurnState, { status: "submitting" | "working" | "retrying" }>,
  now: number,
): CoachTurnState {
  if (now - state.startedAt <= MAX_ACTIVE_TURN_AGE_MS) return state;
  return { status: "failed", reason: "expired", failedAt: now };
}

function getLatestTurnMessages(messages: readonly UIMessage[]): readonly UIMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "user") return messages.slice(index);
  }
  return messages;
}

function getLatestAttempt(messages: readonly UIMessage[]) {
  let failedMessage: UIMessage | null = null;
  let failedIndex = -1;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "assistant" && message.status === "failed") {
      failedMessage = message;
      failedIndex = index;
    }
  }

  return {
    failedMessage,
    messages: messages.slice(failedIndex + 1),
  };
}

export function hasRetryLease(message: UIMessage): boolean {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || !("roniTurn" in metadata)) return false;
  const turn = metadata.roniTurn;
  return !!turn && typeof turn === "object" && "phase" in turn && turn.phase === "retrying";
}

function getApprovalContinuation(messages: readonly UIMessage[]) {
  let continuation: { key: string; awaitingText: boolean } | null = null;

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "dynamic-tool" && part.approval?.approved !== undefined) {
        continuation = {
          key: part.approval.id || part.toolCallId,
          awaitingText: true,
        };
      } else if (continuation && part.type === "text" && part.text.trim()) {
        continuation = { key: continuation.key, awaitingText: false };
      }
    }
  }

  return continuation;
}

export function getApprovalContinuationKey(messages: readonly UIMessage[]): string | null {
  const latestTurn = getLatestTurnMessages(messages);
  return getApprovalContinuation(getLatestAttempt(latestTurn).messages)?.key ?? null;
}

export function deriveCoachTurnState({
  messages,
  pendingMessage,
  now,
  approvalContinuationStartedAt,
}: {
  messages: readonly UIMessage[];
  pendingMessage: UIMessage | null;
  now: number;
  approvalContinuationStartedAt?: number | null;
}): CoachTurnState {
  if (pendingMessage) {
    return expireActiveState(
      { status: "submitting", startedAt: pendingMessage._creationTime },
      now,
    );
  }

  const turnMessages = getLatestTurnMessages(messages);
  if (turnMessages.length === 0) return { status: "idle" };

  const startedAt = turnMessages[0]._creationTime;
  const latestAttempt = getLatestAttempt(turnMessages);
  const isRetrying = turnMessages.some(hasRetryLease);
  const latestMessage = latestAttempt.messages.at(-1);
  if (!latestMessage && latestAttempt.failedMessage) {
    if (isRetrying) {
      return expireActiveState({ status: "retrying", activity: "preparing", startedAt }, now);
    }
    const failedAt = latestAttempt.failedMessage._creationTime;
    return { status: "failed", reason: "response", failedAt };
  }
  if (!latestMessage) return { status: "idle" };

  const isAwaitingApproval = latestAttempt.messages.some((message) =>
    message.parts.some(
      (part) => part.type === "dynamic-tool" && part.state === "approval-requested",
    ),
  );
  if (isAwaitingApproval) return { status: "awaiting-approval", startedAt };

  const approvalContinuation = getApprovalContinuation(latestAttempt.messages);
  const hasRunningTool = latestAttempt.messages.some((message) =>
    message.parts.some(
      (part) =>
        part.type === "dynamic-tool" &&
        (part.state === "input-streaming" || part.state === "input-available"),
    ),
  );
  const isStreamingText = latestAttempt.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.status === "streaming" &&
      message.text.trim().length > 0,
  );
  const isPreparing =
    latestMessage.role === "user" ||
    approvalContinuation?.awaitingText ||
    latestAttempt.messages.some(
      (message) =>
        message.status === "pending" ||
        (message.role === "assistant" && message.status === "streaming"),
    );
  const activity: CoachActivity | null = hasRunningTool
    ? "tool"
    : isStreamingText
      ? "responding"
      : isPreparing
        ? "preparing"
        : null;
  if (isRetrying) {
    const activeStartedAt = approvalContinuation
      ? (approvalContinuationStartedAt ?? now)
      : startedAt;
    return expireActiveState(
      { status: "retrying", activity: activity ?? "preparing", startedAt: activeStartedAt },
      now,
    );
  }
  if (activity) {
    const activeStartedAt = approvalContinuation
      ? (approvalContinuationStartedAt ?? now)
      : startedAt;
    return expireActiveState({ status: "working", activity, startedAt: activeStartedAt }, now);
  }

  if (latestMessage.role === "assistant" && latestMessage.status === "success") {
    return { status: "complete", completedAt: latestMessage._creationTime };
  }

  return { status: "idle" };
}
