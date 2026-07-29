import { describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { RETRYING_MESSAGE_ERROR } from "./resilienceReporting";
import {
  CONVEX_ACTION_MAX_MS,
  finalizeStuckTurnMessages,
  STUCK_MESSAGE_GRACE_MS,
  STUCK_MESSAGE_WATCHDOG_DELAY_MS,
} from "./stuckMessageWatchdog";

const NOW = 1_700_000_000_000;
const TURN_REF = { threadId: "thread-1", promptMessageId: "prompt-1" };

interface FakeMessage {
  _id: string;
  _creationTime: number;
  threadId: string;
  order: number;
  status: "pending" | "success" | "failed";
  error?: string;
}

function makeCtx(
  messages: FakeMessage[],
  anchor: FakeMessage | null = {
    _id: "prompt-1",
    _creationTime: NOW - STUCK_MESSAGE_GRACE_MS - 120_000,
    threadId: "thread-1",
    order: 1,
    status: "success",
  },
) {
  const runMutation = vi.fn(async () => undefined);
  const runQuery = vi.fn(
    async (
      _reference: unknown,
      args: { messageIds?: string[]; statuses?: Array<FakeMessage["status"]> },
    ) =>
      args.messageIds
        ? [anchor]
        : {
            page: args.statuses
              ? messages.filter((message) => args.statuses?.includes(message.status))
              : messages,
            isDone: true,
            continueCursor: "",
          },
  );
  const ctx = { runQuery, runMutation } as unknown as Pick<MutationCtx, "runQuery" | "runMutation">;
  return { ctx, runMutation, runQuery };
}

describe("finalizeStuckTurnMessages", () => {
  it("finalizes an assistant message stuck pending past the grace window", async () => {
    const stuckAt = NOW - STUCK_MESSAGE_GRACE_MS - 60_000;
    const { ctx, runMutation, runQuery } = makeCtx([
      {
        _id: "stuck-assistant",
        _creationTime: stuckAt,
        threadId: "thread-1",
        order: 1,
        status: "pending",
      },
    ]);

    const finalized = await finalizeStuckTurnMessages(ctx, TURN_REF, NOW);

    expect(finalized).toBe(1);
    expect(runMutation).toHaveBeenCalledWith(
      components.agent.messages.updateMessage,
      expect.objectContaining({
        messageId: "stuck-assistant",
        patch: { status: "failed", error: "stuck_timeout" },
      }),
    );
    expect(runQuery).toHaveBeenCalledWith(components.agent.messages.listMessagesByThreadId, {
      threadId: "thread-1",
      upToAndIncludingMessageId: "prompt-1",
      paginationOpts: { cursor: null, numItems: 50 },
      order: "desc",
      statuses: ["pending"],
    });
  });

  it("leaves a recently created pending message alone (in-flight turn)", async () => {
    const recentAt = NOW - 60_000;
    const { ctx, runMutation } = makeCtx([
      {
        _id: "in-flight",
        _creationTime: recentAt,
        threadId: "thread-1",
        order: 1,
        status: "pending",
      },
    ]);

    const finalized = await finalizeStuckTurnMessages(ctx, TURN_REF, NOW);

    expect(finalized).toBe(0);
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("releases a retry lease after its owning action is proven dead", async () => {
    const retryAnchor = {
      _id: "prompt-1",
      _creationTime: NOW - STUCK_MESSAGE_GRACE_MS - 60_000,
      threadId: "thread-1",
      order: 1,
      status: "success" as const,
      error: RETRYING_MESSAGE_ERROR,
    };
    const { ctx, runMutation } = makeCtx([], retryAnchor);

    const finalized = await finalizeStuckTurnMessages(ctx, TURN_REF, NOW);

    expect(finalized).toBe(1);
    expect(runMutation).toHaveBeenCalledWith(components.agent.messages.updateMessage, {
      messageId: "prompt-1",
      patch: { error: "stuck_timeout" },
    });
  });

  it("keeps a recent prompt lease while its action may still be alive", async () => {
    const retryAnchor = {
      _id: "prompt-1",
      _creationTime: NOW - 60_000,
      threadId: "thread-1",
      order: 1,
      status: "success" as const,
      error: RETRYING_MESSAGE_ERROR,
    };
    const { ctx, runMutation } = makeCtx([], retryAnchor);

    const finalized = await finalizeStuckTurnMessages(ctx, TURN_REF, NOW);

    expect(finalized).toBe(0);
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("ignores already-terminal messages", async () => {
    const oldAt = NOW - STUCK_MESSAGE_GRACE_MS - 60_000;
    const { ctx, runMutation } = makeCtx([
      {
        _id: "done",
        _creationTime: oldAt,
        threadId: "thread-1",
        order: 1,
        status: "success",
      },
      {
        _id: "errored",
        _creationTime: oldAt,
        threadId: "thread-1",
        order: 1,
        status: "failed",
      },
    ]);

    const finalized = await finalizeStuckTurnMessages(ctx, TURN_REF, NOW);

    expect(finalized).toBe(0);
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("only finalizes the scheduled turn order, not another pending turn", async () => {
    const { ctx, runMutation } = makeCtx([
      {
        _id: "other-turn",
        _creationTime: NOW - STUCK_MESSAGE_GRACE_MS - 60_000,
        threadId: "thread-1",
        order: 2,
        status: "pending",
      },
      {
        _id: "scheduled-turn",
        _creationTime: NOW - STUCK_MESSAGE_GRACE_MS - 30_000,
        threadId: "thread-1",
        order: 1,
        status: "pending",
      },
    ]);

    const finalized = await finalizeStuckTurnMessages(ctx, TURN_REF, NOW);

    expect(finalized).toBe(1);
    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: "scheduled-turn" }),
    );
    expect(runMutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: "other-turn" }),
    );
  });

  it("never finalizes a message whose owning action could still be alive", () => {
    // The grace window must exceed the Convex action cap so a swept message's
    // owning action (which started no later than the message's creation) is
    // provably dead.
    expect(STUCK_MESSAGE_GRACE_MS).toBeGreaterThan(CONVEX_ACTION_MAX_MS);
  });

  it("waits long enough to catch a row created at the end of the action's life", () => {
    // A turn's retry path can create the final attempt's assistant row up to a
    // full action lifetime after the watchdog is scheduled. If the delay did not
    // exceed grace + the action cap, the single per-turn sweep would see that
    // late row as too new, skip it, and queue no later sweep — stranding it.
    expect(STUCK_MESSAGE_WATCHDOG_DELAY_MS - STUCK_MESSAGE_GRACE_MS).toBeGreaterThan(
      CONVEX_ACTION_MAX_MS,
    );
  });
});
