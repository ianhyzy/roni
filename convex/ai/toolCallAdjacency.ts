/**
 * Belt-and-suspenders adjacency repair pass for stripOrphanedToolCalls.
 *
 * Gemini's hard rule: a function-call turn MUST be immediately followed by a
 * function-response turn. The set-based logic in stripOrphanedToolCalls proves
 * a matching tool-result / approval-response exists *somewhere* in history,
 * but not that it sits in the slot Gemini requires. This pass walks the
 * surviving messages and drops any tool-call (or stray tool message) that
 * fails the adjacency check.
 *
 * Tracking: PostHog issue 019d510a — "Please ensure that function call turn
 * comes immediately after a user turn or after a function response turn."
 */

import type { ModelMessage } from "ai";

interface ToolCallPart {
  readonly type: string;
  readonly toolCallId?: string;
  readonly approvalId?: string;
}

function partsOf(content: ModelMessage["content"]): readonly ToolCallPart[] {
  if (typeof content === "string" || !Array.isArray(content)) return [];
  // Validated upstream by the `ai` SDK; we only read the discriminated `type`
  // string and a couple of optional id fields, so this cast is safe.
  return content as readonly ToolCallPart[];
}

function collectToolPartIds(content: ModelMessage["content"]): {
  toolCallIds: Set<string>;
  approvalIds: Set<string>;
} {
  const toolCallIds = new Set<string>();
  const approvalIds = new Set<string>();
  for (const part of partsOf(content)) {
    if (part.type === "tool-result" && part.toolCallId) {
      toolCallIds.add(part.toolCallId);
    }
    if (part.type === "tool-approval-response" && part.approvalId) {
      approvalIds.add(part.approvalId);
    }
  }
  return { toolCallIds, approvalIds };
}

interface DropCounter {
  count: number;
}

function repairAssistantToolCalls(
  repaired: (ModelMessage | null)[],
  approvalIdToToolCallId: ReadonlyMap<string, string>,
  liveApprovalToolCallIds: ReadonlySet<string>,
  drops: DropCounter,
): void {
  for (let i = 0; i < repaired.length; i++) {
    const msg = repaired[i];
    if (!msg || msg.role !== "assistant") continue;

    const parts = partsOf(msg.content);
    if (parts.length === 0) continue;
    if (!parts.some((p) => p.type === "tool-call")) continue;

    const next = repaired[i + 1];
    const nextIds =
      next && next.role === "tool"
        ? collectToolPartIds(next.content)
        : { toolCallIds: new Set<string>(), approvalIds: new Set<string>() };

    const filtered = parts.filter((part) => {
      if (part.type !== "tool-call") return true;
      if (!part.toolCallId) return false;
      // Pending live-approval flow: the assistant is awaiting the user's
      // approve/deny click. The agent runtime appends the approval-response
      // before the next model call, so preserving the tool-call here keeps
      // the chain intact through that next turn.
      if (liveApprovalToolCallIds.has(part.toolCallId)) return true;
      if (nextIds.toolCallIds.has(part.toolCallId)) return true;
      for (const apprId of nextIds.approvalIds) {
        if (approvalIdToToolCallId.get(apprId) === part.toolCallId) return true;
      }
      return false;
    });

    if (filtered.length === 0) {
      repaired[i] = null;
      drops.count += 1;
    } else if (filtered.length !== parts.length) {
      repaired[i] = { ...msg, content: filtered } as ModelMessage;
      drops.count += parts.length - filtered.length;
    }
  }
}

function repairOrphanToolMessages(
  repaired: (ModelMessage | null)[],
  approvalIdToToolCallId: ReadonlyMap<string, string>,
  drops: DropCounter,
): void {
  for (let i = 0; i < repaired.length; i++) {
    const msg = repaired[i];
    if (!msg || msg.role !== "tool") continue;

    const prev = i > 0 ? repaired[i - 1] : null;
    if (!prev || prev.role !== "assistant") {
      repaired[i] = null;
      drops.count += 1;
      continue;
    }
    const prevToolCallIds = new Set<string>();
    for (const part of partsOf(prev.content)) {
      if (part.type === "tool-call" && part.toolCallId) {
        prevToolCallIds.add(part.toolCallId);
      }
    }
    if (prevToolCallIds.size === 0) {
      repaired[i] = null;
      drops.count += 1;
      continue;
    }

    const parts = partsOf(msg.content);
    if (parts.length === 0) continue;
    const filtered = parts.filter((part) => {
      if (part.type === "tool-result") {
        return part.toolCallId !== undefined && prevToolCallIds.has(part.toolCallId);
      }
      if (part.type === "tool-approval-response") {
        if (!part.approvalId) return false;
        const tcId = approvalIdToToolCallId.get(part.approvalId);
        return tcId !== undefined && prevToolCallIds.has(tcId);
      }
      return true;
    });

    if (filtered.length === 0) {
      repaired[i] = null;
      drops.count += 1;
    } else if (filtered.length !== parts.length) {
      repaired[i] = { ...msg, content: filtered } as ModelMessage;
      drops.count += parts.length - filtered.length;
    }
  }
}

export interface AdjacencyRepairResult {
  readonly messages: ModelMessage[];
  /** Count of messages or parts dropped/trimmed by the adjacency pass. >0
   * signals that an upstream persistence anomaly was caught — useful for
   * observability (PostHog issue 019d510a regression watch). */
  readonly dropCount: number;
}

export function enforceToolCallAdjacency(
  messages: readonly ModelMessage[],
  approvalIdToToolCallId: ReadonlyMap<string, string>,
  liveApprovalToolCallIds: ReadonlySet<string>,
): AdjacencyRepairResult {
  const repaired: (ModelMessage | null)[] = [...messages];
  const drops: DropCounter = { count: 0 };
  repairAssistantToolCalls(repaired, approvalIdToToolCallId, liveApprovalToolCallIds, drops);
  repairOrphanToolMessages(repaired, approvalIdToToolCallId, drops);
  return {
    messages: repaired.filter((msg): msg is ModelMessage => msg !== null),
    dropCount: drops.count,
  };
}
