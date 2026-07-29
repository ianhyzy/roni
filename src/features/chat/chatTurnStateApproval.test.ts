import type { UIMessage } from "@convex-dev/agent/react";
import { describe, expect, it } from "vitest";
import { deriveCoachTurnState, MAX_ACTIVE_TURN_AGE_MS } from "./chatTurnState";

function createMessage(overrides: Partial<UIMessage> = {}): UIMessage {
  return {
    id: "message-1",
    key: "message-1",
    _creationTime: 1_000,
    order: 0,
    parts: [{ text: "Hello", type: "text" }],
    role: "user",
    status: "success",
    stepOrder: 0,
    text: "Hello",
    ...overrides,
  };
}

describe("deriveCoachTurnState approval continuations", () => {
  const now = 10_000;

  it("gives approval requests precedence over running tools", () => {
    const assistant = createMessage({
      parts: [
        {
          input: {},
          state: "input-available",
          toolCallId: "call-1",
          toolName: "search_exercises",
          type: "dynamic-tool",
        },
        {
          approval: { id: "approval-1" },
          input: {},
          state: "approval-requested",
          toolCallId: "call-2",
          toolName: "approve_week_plan",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
      status: "streaming",
      text: "",
    });

    expect(
      deriveCoachTurnState({ messages: [createMessage(), assistant], now, pendingMessage: null }),
    ).toEqual({ startedAt: 1_000, status: "awaiting-approval" });
  });

  it("keeps an approval request open for the user beyond the action window", () => {
    const assistant = createMessage({
      parts: [
        {
          approval: { id: "approval-1" },
          input: {},
          state: "approval-requested",
          toolCallId: "call-1",
          toolName: "approve_week_plan",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
      status: "success",
      text: "",
    });

    expect(
      deriveCoachTurnState({
        messages: [createMessage(), assistant],
        now: MAX_ACTIVE_TURN_AGE_MS + 20_000,
        pendingMessage: null,
      }),
    ).toEqual({ startedAt: 1_000, status: "awaiting-approval" });
  });

  it("keeps a denied approval active until the coach acknowledges it", () => {
    const deniedTool = {
      approval: { approved: false, id: "approval-1" },
      input: {},
      state: "output-denied",
      toolCallId: "call-1",
      toolName: "approve_week_plan",
      type: "dynamic-tool",
    } satisfies UIMessage["parts"][number];
    const assistant = createMessage({
      parts: [deniedTool],
      role: "assistant",
      status: "success",
      text: "",
    });

    expect(
      deriveCoachTurnState({
        approvalContinuationStartedAt: 9_000,
        messages: [createMessage(), assistant],
        now,
        pendingMessage: null,
      }),
    ).toEqual({ activity: "preparing", startedAt: 9_000, status: "working" });

    const acknowledged = createMessage({
      _creationTime: 2_000,
      parts: [deniedTool, { text: "No problem. I did not make that change.", type: "text" }],
      role: "assistant",
      status: "success",
      text: "No problem. I did not make that change.",
    });
    expect(
      deriveCoachTurnState({
        messages: [createMessage(), acknowledged],
        now,
        pendingMessage: null,
      }),
    ).toEqual({ completedAt: 2_000, status: "complete" });
  });

  it("starts the expiry window when a delayed approval response is observed", () => {
    const delayedNow = MAX_ACTIVE_TURN_AGE_MS + 30_000;
    const assistant = createMessage({
      parts: [
        {
          approval: { approved: true, id: "approval-1" },
          input: {},
          state: "approval-responded",
          toolCallId: "call-1",
          toolName: "approve_week_plan",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
      status: "success",
      text: "",
    });

    expect(
      deriveCoachTurnState({
        approvalContinuationStartedAt: delayedNow - 1_000,
        messages: [createMessage(), assistant],
        now: delayedNow,
        pendingMessage: null,
      }),
    ).toEqual({ activity: "preparing", startedAt: delayedNow - 1_000, status: "working" });

    expect(
      deriveCoachTurnState({
        approvalContinuationStartedAt: delayedNow - MAX_ACTIVE_TURN_AGE_MS - 1,
        messages: [createMessage(), assistant],
        now: delayedNow,
        pendingMessage: null,
      }),
    ).toEqual({ failedAt: delayedNow, reason: "expired", status: "failed" });
  });

  it("uses the fresh continuation clock when an old approval begins retrying", () => {
    const delayedNow = MAX_ACTIVE_TURN_AGE_MS + 30_000;
    const assistant = createMessage({
      metadata: { roniTurn: { phase: "retrying" } },
      parts: [
        {
          approval: { approved: true, id: "approval-1" },
          input: {},
          state: "approval-responded",
          toolCallId: "call-1",
          toolName: "approve_week_plan",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
      status: "success",
      text: "",
    });

    expect(
      deriveCoachTurnState({
        approvalContinuationStartedAt: delayedNow - 1_000,
        messages: [createMessage(), assistant],
        now: delayedNow,
        pendingMessage: null,
      }),
    ).toEqual({
      activity: "preparing",
      startedAt: delayedNow - 1_000,
      status: "retrying",
    });
  });
});
