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

describe("deriveCoachTurnState", () => {
  const now = 10_000;

  it("derives idle and optimistic submission states", () => {
    expect(deriveCoachTurnState({ messages: [], now, pendingMessage: null })).toEqual({
      status: "idle",
    });

    const pendingMessage = createMessage({ _creationTime: 9_000, status: "pending" });
    expect(deriveCoachTurnState({ messages: [], now, pendingMessage })).toEqual({
      status: "submitting",
      startedAt: 9_000,
    });
  });

  it("keeps a failed response active only while its durable retry lease is fresh", () => {
    const firstFailure = createMessage({
      _creationTime: 1_500,
      parts: [],
      role: "assistant",
      status: "failed",
      text: "",
    });
    const retryFailure = createMessage({
      _creationTime: 2_000,
      parts: [],
      role: "assistant",
      status: "failed",
      text: "",
    });
    const retryMarker = createMessage({
      ...retryFailure,
      metadata: { roniTurn: { phase: "retrying" } },
    });

    expect(
      deriveCoachTurnState({
        messages: [createMessage(), firstFailure, retryMarker],
        now: 10_000,
        pendingMessage: null,
      }),
    ).toEqual({ activity: "preparing", startedAt: 1_000, status: "retrying" });

    expect(
      deriveCoachTurnState({
        messages: [createMessage(), firstFailure, retryMarker],
        now: MAX_ACTIVE_TURN_AGE_MS + 100_000,
        pendingMessage: null,
      }),
    ).toEqual({
      failedAt: MAX_ACTIVE_TURN_AGE_MS + 100_000,
      reason: "expired",
      status: "failed",
    });

    expect(
      deriveCoachTurnState({
        messages: [createMessage(), firstFailure, retryFailure],
        now: MAX_ACTIVE_TURN_AGE_MS + 100_000,
        pendingMessage: null,
      }),
    ).toEqual({ failedAt: 2_000, reason: "response", status: "failed" });

    const latestUser = createMessage({ _creationTime: 3_000, key: "user-2", order: 1 });
    const latestFailure = createMessage({
      _creationTime: 4_000,
      key: "failure-2",
      order: 1,
      parts: [],
      role: "assistant",
      status: "failed",
      text: "",
    });
    expect(
      deriveCoachTurnState({
        messages: [retryMarker, latestUser, latestFailure],
        now,
        pendingMessage: null,
      }),
    ).toEqual({ failedAt: 4_000, reason: "response", status: "failed" });
  });

  it("uses only the newest retry attempt after a failed assistant row", () => {
    const user = createMessage();
    const failed = createMessage({
      _creationTime: 2_000,
      parts: [],
      role: "assistant",
      status: "failed",
      text: "",
    });
    const retryStreaming = createMessage({
      _creationTime: 6_000,
      parts: [{ text: "Trying again", type: "text" }],
      role: "assistant",
      status: "streaming",
      text: "Trying again",
    });
    const retrySuccess = createMessage({
      _creationTime: 7_000,
      parts: [{ text: "Done", type: "text" }],
      role: "assistant",
      status: "success",
      text: "Done",
    });

    expect(
      deriveCoachTurnState({
        messages: [user, failed, retryStreaming],
        now,
        pendingMessage: null,
      }),
    ).toEqual({ activity: "responding", startedAt: 1_000, status: "working" });
    expect(
      deriveCoachTurnState({
        messages: [user, failed, retrySuccess],
        now,
        pendingMessage: null,
      }),
    ).toEqual({ completedAt: 7_000, status: "complete" });
  });

  it("ignores stale tool and approval parts from a failed attempt", () => {
    const failed = createMessage({
      _creationTime: 2_000,
      parts: [
        {
          approval: { id: "approval-1" },
          input: {},
          state: "approval-requested",
          toolCallId: "call-1",
          toolName: "approve_week_plan",
          type: "dynamic-tool",
        },
        {
          input: {},
          state: "input-available",
          toolCallId: "call-2",
          toolName: "search_exercises",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
      status: "failed",
      text: "",
    });
    const retry = createMessage({
      _creationTime: 6_000,
      parts: [],
      role: "assistant",
      status: "streaming",
      text: "",
    });

    expect(
      deriveCoachTurnState({
        messages: [createMessage(), failed, retry],
        now,
        pendingMessage: null,
      }),
    ).toEqual({ activity: "preparing", startedAt: 1_000, status: "working" });
  });

  it("distinguishes tool use, streaming text, and preparation", () => {
    const user = createMessage();
    const tool = createMessage({
      parts: [
        {
          input: {},
          state: "input-available",
          toolCallId: "call-1",
          toolName: "search_exercises",
          type: "dynamic-tool",
        },
      ],
      role: "assistant",
      status: "streaming",
      text: "",
    });
    const response = createMessage({
      parts: [{ text: "Working on it", type: "text" }],
      role: "assistant",
      status: "streaming",
      text: "Working on it",
    });

    expect(deriveCoachTurnState({ messages: [user, tool], now, pendingMessage: null })).toEqual({
      activity: "tool",
      startedAt: 1_000,
      status: "working",
    });
    expect(deriveCoachTurnState({ messages: [user, response], now, pendingMessage: null })).toEqual(
      {
        activity: "responding",
        startedAt: 1_000,
        status: "working",
      },
    );
    expect(deriveCoachTurnState({ messages: [user], now, pendingMessage: null })).toEqual({
      activity: "preparing",
      startedAt: 1_000,
      status: "working",
    });
  });

  it("derives terminal success and ignores failures from older turns", () => {
    const oldFailure = createMessage({ _creationTime: 500, role: "assistant", status: "failed" });
    const user = createMessage({ _creationTime: 2_000, key: "user-2" });
    const assistant = createMessage({
      _creationTime: 3_000,
      key: "assistant-2",
      role: "assistant",
      status: "success",
    });

    expect(
      deriveCoachTurnState({
        messages: [oldFailure, user, assistant],
        now,
        pendingMessage: null,
      }),
    ).toEqual({ completedAt: 3_000, status: "complete" });
  });

  it("expires non-terminal state at the watchdog horizon", () => {
    const startedAt = now - MAX_ACTIVE_TURN_AGE_MS - 1;
    const user = createMessage({ _creationTime: startedAt });

    expect(deriveCoachTurnState({ messages: [user], now, pendingMessage: null })).toEqual({
      failedAt: now,
      reason: "expired",
      status: "failed",
    });
  });
});
