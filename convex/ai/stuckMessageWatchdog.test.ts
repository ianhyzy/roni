import { describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import {
  CONVEX_ACTION_MAX_MS,
  finalizeStuckThreadMessages,
  STUCK_MESSAGE_GRACE_MS,
  STUCK_MESSAGE_WATCHDOG_DELAY_MS,
} from "./stuckMessageWatchdog";

const NOW = 1_700_000_000_000;

interface FakeMessage {
  _id: string;
  _creationTime: number;
  status: "pending" | "success" | "failed";
}

function makeCtx(messages: FakeMessage[]) {
  const runMutation = vi.fn(async () => undefined);
  const runQuery = vi.fn(async () => ({
    page: messages,
    isDone: true,
    continueCursor: "",
  }));
  const ctx = { runQuery, runMutation } as unknown as Pick<MutationCtx, "runQuery" | "runMutation">;
  return { ctx, runMutation, runQuery };
}

describe("finalizeStuckThreadMessages", () => {
  it("finalizes an assistant message stuck pending past the grace window", async () => {
    const stuckAt = NOW - STUCK_MESSAGE_GRACE_MS - 60_000;
    const { ctx, runMutation, runQuery } = makeCtx([
      { _id: "stuck-assistant", _creationTime: stuckAt, status: "pending" },
    ]);

    const finalized = await finalizeStuckThreadMessages(ctx, "thread-1", NOW);

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
      paginationOpts: { cursor: null, numItems: 50 },
      order: "desc",
      statuses: ["pending"],
    });
  });

  it("leaves a recently created pending message alone (in-flight turn)", async () => {
    const recentAt = NOW - 60_000;
    const { ctx, runMutation } = makeCtx([
      { _id: "in-flight", _creationTime: recentAt, status: "pending" },
    ]);

    const finalized = await finalizeStuckThreadMessages(ctx, "thread-1", NOW);

    expect(finalized).toBe(0);
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("ignores already-terminal messages", async () => {
    const oldAt = NOW - STUCK_MESSAGE_GRACE_MS - 60_000;
    const { ctx, runMutation } = makeCtx([
      { _id: "done", _creationTime: oldAt, status: "success" },
      { _id: "errored", _creationTime: oldAt, status: "failed" },
    ]);

    const finalized = await finalizeStuckThreadMessages(ctx, "thread-1", NOW);

    expect(finalized).toBe(0);
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("only finalizes the stuck message, not a newer in-flight one in the same thread", async () => {
    const { ctx, runMutation } = makeCtx([
      { _id: "newer", _creationTime: NOW - 30_000, status: "pending" },
      { _id: "stuck", _creationTime: NOW - STUCK_MESSAGE_GRACE_MS - 30_000, status: "pending" },
    ]);

    const finalized = await finalizeStuckThreadMessages(ctx, "thread-1", NOW);

    expect(finalized).toBe(1);
    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: "stuck" }),
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
