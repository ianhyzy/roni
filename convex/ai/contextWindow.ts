/**
 * Message processing pipeline for the coach agent's context handler.
 * Cleans, merges, and windows conversation history before sending to the LLM.
 */

import type { ModelMessage, UserContent } from "ai";
import { readToolPartReference, withAssistantParts, withToolParts } from "./modelMessageToolParts";
import { hasSearchProvenance, withSearchProvenance } from "./searchProvenance";

// ---------------------------------------------------------------------------
// Merge consecutive same-role messages
// ---------------------------------------------------------------------------

export function mergeConsecutiveSameRole(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length <= 1) return messages;

  const result: ModelMessage[] = [messages[0]];

  for (let i = 1; i < messages.length; i++) {
    const prev = result[result.length - 1];
    const curr = messages[i];

    // Never merge system messages; the provider extracts them separately.
    if (prev.role !== curr.role || prev.role === "system") {
      result.push(curr);
      continue;
    }

    const toParts = (c: ModelMessage["content"]): Array<Record<string, unknown>> =>
      typeof c === "string" ? [{ type: "text", text: c }] : (c as Array<Record<string, unknown>>);

    const merged = [...toParts(prev.content), ...toParts(curr.content)];
    const mergedMessage = {
      ...prev,
      content: merged,
    } as ModelMessage;
    result[result.length - 1] =
      hasSearchProvenance(prev) || hasSearchProvenance(curr)
        ? withSearchProvenance(mergedMessage)
        : mergedMessage;
  }

  return result;
}

// Strip orphaned tool calls.

export function stripOrphanedToolCalls(messages: ModelMessage[]): ModelMessage[] {
  // A request is live only while no fresh user prompt follows it. Otherwise
  // the required tool-call → tool-result adjacency is broken and Gemini rejects
  // the history. Approval responses use the tool role, not the user role.
  let lastFreshUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastFreshUserIdx = i;
      break;
    }
  }

  const approvalIdToToolCallId = new Map<string, string>();
  const liveApprovalIds = new Set<string>();
  const liveApprovalToolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  const approvalResponseIds = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const reference = readToolPartReference(part);
      if (!reference) continue;
      if (
        reference.type === "tool-approval-request" &&
        reference.approvalId &&
        reference.toolCallId
      ) {
        approvalIdToToolCallId.set(reference.approvalId, reference.toolCallId);
        if (i > lastFreshUserIdx) {
          liveApprovalIds.add(reference.approvalId);
          liveApprovalToolCallIds.add(reference.toolCallId);
        }
      }
      if (reference.type === "tool-result" && reference.toolCallId) {
        toolResultIds.add(reference.toolCallId);
      }
      if (reference.type === "tool-approval-response" && reference.approvalId) {
        approvalResponseIds.add(reference.approvalId);
      }
    }
  }

  const resolvedToolCallIds = new Set(toolResultIds);
  for (const approvalId of approvalResponseIds) {
    const toolCallId = approvalIdToToolCallId.get(approvalId);
    if (toolCallId) resolvedToolCallIds.add(toolCallId);
  }

  // Build the set of tool-call ids that survive the assistant-message filter
  // below. Any `tool` role message whose tool-result references a non-kept
  // call is orphaned (typically from a partially-persisted failed stream)
  // and must be dropped — Gemini rejects history where a tool turn doesn't
  // immediately follow its originating user/function-response turn.
  const keptAssistantToolCallIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const reference = readToolPartReference(part);
      if (reference?.type !== "tool-call" || !reference.toolCallId) continue;
      if (
        resolvedToolCallIds.has(reference.toolCallId) ||
        liveApprovalToolCallIds.has(reference.toolCallId)
      ) {
        keptAssistantToolCallIds.add(reference.toolCallId);
      }
    }
  }

  // A completed approval survives only with its response. A pending approval
  // survives only while live and before a tool result proves execution moved on.
  const keptApprovalIds = new Set<string>();
  for (const [approvalId, toolCallId] of approvalIdToToolCallId) {
    if (!keptAssistantToolCallIds.has(toolCallId)) continue;
    if (
      approvalResponseIds.has(approvalId) ||
      (liveApprovalIds.has(approvalId) && !toolResultIds.has(toolCallId))
    ) {
      keptApprovalIds.add(approvalId);
    }
  }

  return messages
    .map((msg) => {
      if (msg.role === "assistant") {
        if (typeof msg.content === "string" || !Array.isArray(msg.content)) return msg;

        // A tool-approval-request must be dropped alongside the tool-call it
        // points at, even when persistence split them across assistant messages.
        // Left behind, @convex-dev/agent's autoDenyUnresolvedApprovals creates a
        // denial for a tool the user never declined.
        const filtered = msg.content.filter((part) => {
          const reference = readToolPartReference(part);
          if (!reference) return false;
          if (reference.type === "tool-call") {
            return (
              reference.toolCallId !== undefined &&
              keptAssistantToolCallIds.has(reference.toolCallId)
            );
          }
          if (reference.type === "tool-approval-request") {
            return reference.approvalId !== undefined && keptApprovalIds.has(reference.approvalId);
          }
          return true;
        });

        if (filtered.length === 0) return null;
        return withAssistantParts(msg, filtered);
      }

      if (msg.role === "tool") {
        if (typeof msg.content === "string" || !Array.isArray(msg.content)) return msg;

        // tool-approval-response parts are keyed by approvalId, not toolCallId.
        // Keep one only when its originating request survived above — a response
        // whose request was trimmed away makes the AI SDK throw
        // InvalidToolApprovalError on the next turn.
        const filtered = msg.content.filter((part) => {
          const reference = readToolPartReference(part);
          if (!reference) return false;
          return reference.type === "tool-approval-response"
            ? reference.approvalId !== undefined && keptApprovalIds.has(reference.approvalId)
            : reference.toolCallId !== undefined &&
                keptAssistantToolCallIds.has(reference.toolCallId);
        });

        if (filtered.length === 0) return null;
        return withToolParts(msg, filtered);
      }

      return msg;
    })
    .filter((msg): msg is ModelMessage => msg !== null);
}

// ---------------------------------------------------------------------------
// Strip images from older messages
// ---------------------------------------------------------------------------

/**
 * Remove image parts from all messages except the most recent user message.
 * Images stored in older messages cause unbounded memory growth when loaded
 * via recentMessages, leading to 64 MB OOM on Convex actions.
 */
export function stripImagesFromOlderMessages(messages: ModelMessage[]): ModelMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  return messages.map((msg, idx) => {
    if (idx === lastUserIdx) return msg;
    if (msg.role !== "user") return msg;
    if (typeof msg.content === "string") return msg;
    if (!Array.isArray(msg.content)) return msg;

    const filtered = (msg.content as Array<{ type: string }>).filter(
      (part) => part.type !== "image",
    );
    if (filtered.length === 0) {
      return { ...msg, content: "[image message]" };
    }
    return { ...msg, content: filtered as UserContent };
  });
}

// ---------------------------------------------------------------------------
// Turn-aware context windowing
// ---------------------------------------------------------------------------

/** ~4 chars per token is a conservative estimate for mixed English + JSON. */
export function estimateMessageTokens(content: ModelMessage["content"]): number {
  const text = typeof content === "string" ? content : (JSON.stringify(content) ?? "");
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message.content), 0);
}

/**
 * Select the most recent complete conversation turns that fit within a
 * token budget. A "turn" starts at a user message and includes every
 * following message until the next user message. This guarantees:
 *
 * 1. Context always starts with a user message (Gemini requirement)
 * 2. Tool-call / tool-result chains are never broken
 * 3. Older context is dropped cleanly at turn boundaries
 *
 * Semantic search (searchOtherThreads) already recovers relevant older
 * context, so dropping full turns is safe.
 */
const CONTEXT_TOKEN_BUDGET = 30_000;

export function buildContextWindow(
  messages: ModelMessage[],
  tokenBudget: number = CONTEXT_TOKEN_BUDGET,
): ModelMessage[] {
  if (messages.length === 0) return [];
  if (tokenBudget <= 0) return [];

  // Find every user-message index (turn boundaries)
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") userIndices.push(i);
  }

  if (userIndices.length === 0) return [];

  // Include from the last user message to the end only when that full turn fits.
  let startIdx = userIndices[userIndices.length - 1];
  let tokenCount = 0;
  for (let i = startIdx; i < messages.length; i++) {
    tokenCount += estimateMessageTokens(messages[i].content);
  }
  if (tokenCount > tokenBudget) return [];

  // Walk backward through earlier turns, adding if budget allows
  for (let u = userIndices.length - 2; u >= 0; u--) {
    const turnStart = userIndices[u];
    const turnEnd = userIndices[u + 1];
    let turnTokens = 0;
    for (let i = turnStart; i < turnEnd; i++) {
      turnTokens += estimateMessageTokens(messages[i].content);
    }
    if (tokenCount + turnTokens > tokenBudget) break;
    tokenCount += turnTokens;
    startIdx = turnStart;
  }

  return messages.slice(startIdx);
}

export interface FullPromptContextWindowArgs {
  messages: ModelMessage[];
  promptBudgetTokens: number;
  reservedPromptTokens: number;
}

export function buildFullPromptContextWindow({
  messages,
  promptBudgetTokens,
  reservedPromptTokens,
}: FullPromptContextWindowArgs): ModelMessage[] {
  const messageBudget = Math.max(0, promptBudgetTokens - reservedPromptTokens);
  if (messageBudget <= 0) return [];
  return buildContextWindow(messages, messageBudget);
}
