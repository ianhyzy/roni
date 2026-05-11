import type { Agent } from "@convex-dev/agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import type { ProviderId } from "./providers";
import { streamWithRetry } from "./resilience";

const runWithPrimaryCircuitBreakerMock = vi.hoisted(() => vi.fn());
const recordErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@convex-dev/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/agent")>()),
  saveMessage: vi.fn(async () => undefined),
}));

vi.mock("./otel", () => ({
  runInRunSpan: async (
    _metadata: unknown,
    fn: (span: { runId: string; recordError: (error: string) => void }) => Promise<unknown>,
  ) => fn({ runId: "run-on-error", recordError: recordErrorMock }),
}));

vi.mock("./resilienceCircuitBreaker", () => ({
  runWithPrimaryCircuitBreaker: runWithPrimaryCircuitBreakerMock,
}));

function makeSuccessAgent(): {
  agent: Agent;
} {
  const streamText = vi.fn(async () => ({ text: Promise.resolve("") }));
  const agent = {
    continueThread: vi.fn(async () => ({ thread: { streamText } })),
  } as unknown as Agent;
  return { agent };
}

function baseStreamWithRetryArgs(provider: ProviderId) {
  return {
    primaryModelName: "test-model",
    threadId: "thread-1",
    userId: "user-1",
    prompt: "hello",
    isByok: false,
    provider,
    source: "chat" as const,
    environment: "dev" as const,
  };
}

describe("onError pre-emptive finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runWithPrimaryCircuitBreakerMock.mockImplementation(
      async (options: { primaryAgent: Agent; runAttempt: (agent: Agent) => Promise<unknown> }) =>
        options.runAttempt(options.primaryAgent),
    );
  });

  it("calls finalizeMessage with provider_overload code for Gemini high-demand stream errors", async () => {
    const highDemandError = new Error(
      "This model is currently experiencing high demand. Spikes in demand are usually temporary.",
    );
    const streamText = vi.fn(
      async (options: { onError?: (args: { error: unknown }) => Promise<void> }) => {
        await options.onError?.({ error: highDemandError });
        return { text: Promise.reject(highDemandError) };
      },
    );
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const runQuery = vi.fn(async () => ({
      page: [{ _id: "pending-msg", status: "pending" }],
    }));
    const runMutation = vi.fn(async () => undefined);

    await streamWithRetry({ runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("gemini"),
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "pending-msg",
        result: { status: "failed", error: "provider_overload" },
      }),
    );
  });

  it("does not expose raw provider error text in the finalization code", async () => {
    const rawMessage =
      "This model is currently experiencing high demand. Spikes in demand are usually temporary.";
    const streamText = vi.fn(
      async (options: { onError?: (args: { error: unknown }) => Promise<void> }) => {
        await options.onError?.({ error: new Error(rawMessage) });
        return { text: Promise.reject(new Error(rawMessage)) };
      },
    );
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const runQuery = vi.fn(async () => ({
      page: [{ _id: "msg-1", status: "pending" }],
    }));
    const runMutation = vi.fn(async () => undefined);

    await streamWithRetry({ runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("gemini"),
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: { status: "failed", error: "provider_overload" },
      }),
    );
    expect(runMutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        result: expect.objectContaining({ error: expect.stringContaining("high demand") }),
      }),
    );
  });

  it("finalizes with provider_overload for Claude overload errors as well", async () => {
    const overloadError = new Error("Service overloaded. Please try again later.");
    const streamText = vi.fn(
      async (options: { onError?: (args: { error: unknown }) => Promise<void> }) => {
        await options.onError?.({ error: overloadError });
        return { text: Promise.reject(overloadError) };
      },
    );
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const runQuery = vi.fn(async () => ({
      page: [{ _id: "pending-claude", status: "pending" }],
    }));
    const runMutation = vi.fn(async () => undefined);

    await streamWithRetry({ runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("claude"),
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "pending-claude",
        result: { status: "failed", error: "provider_overload" },
      }),
    );
  });

  it("does not finalize when onError is not called (happy path)", async () => {
    const { agent } = makeSuccessAgent();
    const runQuery = vi.fn(async () => ({ page: [] }));
    const runMutation = vi.fn(async () => undefined);

    const accumulator = await streamWithRetry(
      { runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx,
      {
        primaryAgent: agent,
        fallbackAgent: agent,
        ...baseStreamWithRetryArgs("gemini"),
      },
    );

    expect(accumulator.toRow().finishReason).not.toBe("error");
    expect(runMutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: expect.objectContaining({ status: "failed" }) }),
    );
  });

  it("finalizes pending message via result.text catch when onError is not called", async () => {
    // Guards against the @convex-dev/agent@0.6.1 race condition: an error event
    // may arrive without our onError callback being awaited first. The try-catch
    // around result.text ensures the pending message is finalized regardless.
    const highDemandError = new Error(
      "This model is currently experiencing high demand. Spikes in demand are usually temporary.",
    );
    const streamText = vi.fn(async () => ({
      text: Promise.reject(highDemandError),
    }));
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const runQuery = vi.fn(async () => ({
      page: [{ _id: "pending-msg", status: "pending" }],
    }));
    const runMutation = vi.fn(async () => undefined);

    await streamWithRetry({ runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("gemini"),
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "pending-msg",
        result: { status: "failed", error: "provider_overload" },
      }),
    );
  });
});
