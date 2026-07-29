import { describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import {
  clearTurnRetrying,
  finalizePendingMessages,
  markFailedTurnMessagesAsSuperseded,
  markTurnRetrying,
  RETRYING_MESSAGE_ERROR,
} from "./resilienceReporting";

interface FakeAgentMessage {
  _id: string;
  threadId: string;
  order: number;
  status: "pending" | "success" | "failed";
  error?: string;
}

function makeTurnRunQuery(messages: FakeAgentMessage[], anchor: FakeAgentMessage | null) {
  return vi.fn(async (_reference: unknown, args: { messageIds?: string[] }) => {
    if (args.messageIds) return [anchor];
    return { page: messages, isDone: true, continueCursor: "" };
  });
}

describe("turn-scoped pending message finalization", () => {
  it("only patches pending messages that match the prompt anchor order", async () => {
    const runQuery = makeTurnRunQuery(
      [
        { _id: "pending-turn-b", threadId: "thread-1", order: 2, status: "pending" },
        { _id: "pending-turn-a", threadId: "thread-1", order: 1, status: "pending" },
      ],
      { _id: "prompt-1", threadId: "thread-1", order: 1, status: "success" },
    );
    const runMutation = vi.fn(async () => undefined);

    await finalizePendingMessages(
      { runQuery, runMutation } as unknown as ActionCtx,
      { threadId: "thread-1", promptMessageId: "prompt-1" },
      "provider_overload",
    );

    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(runMutation).toHaveBeenCalledWith(components.agent.messages.updateMessage, {
      messageId: "pending-turn-a",
      patch: { status: "failed", error: "provider_overload" },
    });
    expect(runQuery).toHaveBeenCalledWith(components.agent.messages.getMessagesByIds, {
      messageIds: ["prompt-1"],
    });
    expect(runQuery).toHaveBeenCalledWith(components.agent.messages.listMessagesByThreadId, {
      threadId: "thread-1",
      upToAndIncludingMessageId: "prompt-1",
      paginationOpts: { cursor: null, numItems: 50 },
      order: "desc",
      statuses: ["pending"],
    });
  });

  it.each([
    { name: "missing", anchor: null },
    {
      name: "from another thread",
      anchor: {
        _id: "prompt-1",
        threadId: "thread-2",
        order: 1,
        status: "success" as const,
      },
    },
  ])("does not mutate messages when the prompt anchor is $name", async ({ anchor }) => {
    const runQuery = makeTurnRunQuery(
      [{ _id: "pending-msg", threadId: "thread-1", order: 1, status: "pending" }],
      anchor,
    );
    const runMutation = vi.fn(async () => undefined);

    await finalizePendingMessages(
      { runQuery, runMutation } as unknown as ActionCtx,
      { threadId: "thread-1", promptMessageId: "prompt-1" },
      "network",
    );

    expect(runMutation).not.toHaveBeenCalled();
    expect(runQuery).toHaveBeenCalledTimes(1);
  });
});

describe("turn-scoped retry markers", () => {
  const turnRef = { threadId: "thread-1", promptMessageId: "prompt-1" };
  const anchor = {
    _id: "prompt-1",
    threadId: "thread-1",
    order: 1,
    status: "success" as const,
  };

  it("places the durable lease on the prompt without mutating successful rows", async () => {
    const runQuery = makeTurnRunQuery(
      [
        { _id: "successful-step", threadId: "thread-1", order: 1, status: "success" },
        {
          _id: "failed-attempt",
          threadId: "thread-1",
          order: 1,
          status: "failed",
          error: RETRYING_MESSAGE_ERROR,
        },
        anchor,
      ],
      anchor,
    );
    const runMutation = vi.fn(async () => undefined);

    await markTurnRetrying({ runQuery, runMutation } as unknown as ActionCtx, turnRef);

    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(runMutation).toHaveBeenCalledWith(components.agent.messages.updateMessage, {
      messageId: "prompt-1",
      patch: { error: RETRYING_MESSAGE_ERROR },
    });
  });

  it("uses the prompt row instead of demoting a successful turn row", async () => {
    const runQuery = makeTurnRunQuery(
      [
        { _id: "successful-step", threadId: "thread-1", order: 1, status: "success" },
        { _id: "failed-attempt", threadId: "thread-1", order: 1, status: "failed" },
        anchor,
      ],
      anchor,
    );
    const runMutation = vi.fn(async () => undefined);

    await markTurnRetrying({ runQuery, runMutation } as unknown as ActionCtx, turnRef);

    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(runMutation).toHaveBeenCalledWith(components.agent.messages.updateMessage, {
      messageId: "prompt-1",
      patch: { error: RETRYING_MESSAGE_ERROR },
    });
    expect(runMutation).not.toHaveBeenCalledWith(
      components.agent.messages.updateMessage,
      expect.objectContaining({
        messageId: "successful-step",
        patch: expect.objectContaining({ status: "failed" }),
      }),
    );
  });

  it("fails closed when the prompt anchor is missing", async () => {
    const runQuery = makeTurnRunQuery([], null);

    await expect(
      markTurnRetrying({ runQuery, runMutation: vi.fn() } as unknown as ActionCtx, turnRef),
    ).rejects.toThrow("retry_marker_missing");
  });

  it("uses the prompt row when a transient failure happens before an assistant row exists", async () => {
    const runQuery = makeTurnRunQuery([anchor], anchor);
    const runMutation = vi.fn(async () => undefined);

    await markTurnRetrying({ runQuery, runMutation } as unknown as ActionCtx, turnRef);

    expect(runMutation).toHaveBeenCalledWith(components.agent.messages.updateMessage, {
      messageId: "prompt-1",
      patch: { error: RETRYING_MESSAGE_ERROR },
    });
  });

  it("clears only the anchored prompt lease", async () => {
    const leasedAnchor = { ...anchor, error: RETRYING_MESSAGE_ERROR };
    const runQuery = makeTurnRunQuery(
      [
        {
          _id: "retry-a",
          threadId: "thread-1",
          order: 1,
          status: "failed",
          error: RETRYING_MESSAGE_ERROR,
        },
        {
          _id: "retry-b",
          threadId: "thread-1",
          order: 1,
          status: "failed",
          error: RETRYING_MESSAGE_ERROR,
        },
        {
          _id: "other-turn",
          threadId: "thread-1",
          order: 2,
          status: "failed",
          error: RETRYING_MESSAGE_ERROR,
        },
      ],
      leasedAnchor,
    );
    const runMutation = vi.fn(async () => undefined);

    await clearTurnRetrying(
      { runQuery, runMutation } as unknown as ActionCtx,
      turnRef,
      "retry_complete",
    );

    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(runMutation).toHaveBeenCalledWith(components.agent.messages.updateMessage, {
      messageId: "prompt-1",
      patch: { error: "retry_complete" },
    });
  });

  it("finds and supersedes failed attempt rows beyond the first page", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      _id: `superseded-${index}`,
      threadId: "thread-1",
      order: 1,
      status: "failed" as const,
      error: RETRYING_MESSAGE_ERROR,
    }));
    const failedAttempt = {
      _id: "failed-attempt",
      threadId: "thread-1",
      order: 1,
      status: "failed" as const,
      error: "provider body",
    };
    const runQuery = vi.fn(
      async (
        _reference: unknown,
        args: { messageIds?: string[]; paginationOpts?: { cursor: string | null } },
      ) => {
        if (args.messageIds) return [anchor];
        if (args.paginationOpts?.cursor === null) {
          return { page: firstPage, isDone: false, continueCursor: "page-2" };
        }
        return { page: [failedAttempt], isDone: true, continueCursor: "" };
      },
    );
    const runMutation = vi.fn(async () => undefined);

    await markFailedTurnMessagesAsSuperseded(
      { runQuery, runMutation } as unknown as ActionCtx,
      turnRef,
    );

    expect(runMutation).toHaveBeenCalledWith(components.agent.messages.updateMessage, {
      messageId: "failed-attempt",
      patch: { error: RETRYING_MESSAGE_ERROR },
    });
  });
});
