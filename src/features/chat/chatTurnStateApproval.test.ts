import { type MessageDoc, toUIMessages } from "@convex-dev/agent";
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

type StoredToolScenario = "approval-request" | "approval-response" | "running-tool";

function createStoredToolMessage(scenario: StoredToolScenario): UIMessage {
  const isRunningTool = scenario === "running-tool";
  const request: MessageDoc = {
    _id: isRunningTool ? "message-running-tool" : "message-approval",
    _creationTime: 2_000,
    message: {
      role: "assistant",
      content: isRunningTool
        ? [
            {
              type: "tool-call",
              toolCallId: "tool-call-static",
              toolName: "search_exercises",
              input: { query: "squat" },
            },
          ]
        : [
            {
              type: "tool-call",
              toolCallId: "tool-call-static",
              toolName: "approve_week_plan",
              input: { weekStartDate: "2026-04-06" },
            },
            {
              type: "tool-approval-request",
              approvalId: "approval-static",
              toolCallId: "tool-call-static",
            },
          ],
    },
    order: 1,
    status: "success",
    stepOrder: 0,
    threadId: "thread-1",
    tool: true,
  };

  if (scenario !== "approval-response") return toUIMessages([request])[0];

  const response: MessageDoc = {
    _id: "message-approval-response",
    _creationTime: 2_001,
    message: {
      role: "tool",
      content: [
        {
          type: "tool-approval-response",
          approvalId: "approval-static",
          approved: true,
        },
      ],
    },
    order: 1,
    status: "success",
    stepOrder: 1,
    threadId: "thread-1",
    tool: true,
  };

  return toUIMessages([request, response])[0];
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

  it("waits for stored static tool approval requests", () => {
    expect(
      deriveCoachTurnState({
        messages: [createMessage(), createStoredToolMessage("approval-request")],
        now,
        pendingMessage: null,
      }),
    ).toEqual({ startedAt: 1_000, status: "awaiting-approval" });
  });

  it("keeps a stored static approval response active until the coach acknowledges it", () => {
    expect(
      deriveCoachTurnState({
        approvalContinuationStartedAt: 9_000,
        messages: [createMessage(), createStoredToolMessage("approval-response")],
        now,
        pendingMessage: null,
      }),
    ).toEqual({ activity: "preparing", startedAt: 9_000, status: "working" });
  });

  it("recognizes stored static tool calls as active work", () => {
    expect(
      deriveCoachTurnState({
        messages: [createMessage(), createStoredToolMessage("running-tool")],
        now,
        pendingMessage: null,
      }),
    ).toEqual({ activity: "tool", startedAt: 1_000, status: "working" });
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
