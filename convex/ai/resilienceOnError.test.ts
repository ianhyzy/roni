import type { Agent } from "@convex-dev/agent";
import { APICallError } from "@ai-sdk/provider";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
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
    promptMessageId: "prompt-1",
    userId: "user-1",
    prompt: "hello",
    isByok: false,
    provider,
    source: "chat" as const,
    environment: "dev" as const,
  };
}

interface FakeAgentMessage {
  _id: string;
  _creationTime?: number;
  threadId: string;
  order: number;
  status: "pending" | "success" | "failed";
  error?: string;
}

function makeTurnCtx(initialMessages: FakeAgentMessage[]) {
  const messages = initialMessages.map((message) => ({ ...message }));
  const runQuery = vi.fn(
    async (
      _reference: unknown,
      args: { messageIds?: string[]; statuses?: Array<FakeAgentMessage["status"]> },
    ) => {
      if (args.messageIds) {
        return [{ _id: "prompt-1", threadId: "thread-1", order: 1, status: "success" }];
      }
      return {
        page: args.statuses
          ? messages.filter((message) => args.statuses?.includes(message.status))
          : messages,
        isDone: true,
        continueCursor: "",
      };
    },
  );
  const runMutation = vi.fn(
    async (_reference: unknown, args: { messageId: string; patch: Partial<FakeAgentMessage> }) => {
      const message = messages.find((candidate) => candidate._id === args.messageId);
      if (message) Object.assign(message, args.patch);
    },
  );
  return { runMutation, runQuery };
}

describe("onError pre-emptive finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runWithPrimaryCircuitBreakerMock.mockImplementation(
      async (options: { primaryAgent: Agent; runAttempt: (agent: Agent) => Promise<unknown> }) =>
        options.runAttempt(options.primaryAgent),
    );
  });

  it("atomically marks Gemini transient stream failures as retrying", async () => {
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
    const { runQuery, runMutation } = makeTurnCtx([
      { _id: "pending-turn-a", threadId: "thread-1", order: 1, status: "pending" },
    ]);

    await streamWithRetry({ runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("gemini"),
    });

    expect(runMutation).toHaveBeenCalledWith(
      components.agent.messages.updateMessage,
      expect.objectContaining({
        messageId: "pending-turn-a",
        patch: { status: "failed", error: "transient_retry" },
      }),
    );
  });

  it("preserves provider classification when the UI stream masks the error", async () => {
    const providerError = new APICallError({
      message: "Anthropic is temporarily overloaded",
      url: "https://api.anthropic.test/v1/messages",
      requestBodyValues: {},
      statusCode: 529,
      isRetryable: true,
    });
    const streamText = vi.fn(
      async (options: { onError?: (args: { error: unknown }) => Promise<void> }) => {
        await options.onError?.({ error: providerError });
        throw new Error("An error occurred.");
      },
    );
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const { runQuery, runMutation } = makeTurnCtx([
      { _id: "pending-claude", threadId: "thread-1", order: 1, status: "pending" },
    ]);
    let primaryOutcome: unknown;
    runWithPrimaryCircuitBreakerMock.mockImplementationOnce(
      async (options: { primaryAgent: Agent; runAttempt: (agent: Agent) => Promise<unknown> }) => {
        primaryOutcome = await options.runAttempt(options.primaryAgent);
      },
    );

    const accumulator = await streamWithRetry(
      { runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx,
      {
        primaryAgent: agent,
        fallbackAgent: agent,
        ...baseStreamWithRetryArgs("claude"),
      },
    );

    expect(primaryOutcome).toEqual({ done: false, error: providerError });
    expect(accumulator.toRow().terminalErrorClass).toBeUndefined();
    expect(recordErrorMock).not.toHaveBeenCalled();
    expect(JSON.stringify(runMutation.mock.calls)).not.toContain(providerError.message);
  });

  it("keeps unrelated stream failures terminal after provider onError", async () => {
    const providerError = Object.assign(new Error("Anthropic overloaded"), { status: 529 });
    const streamError = new Error("Agent finalization failed");
    const streamText = vi.fn(
      async (options: { onError?: (args: { error: unknown }) => Promise<void> }) => {
        await options.onError?.({ error: providerError });
        throw streamError;
      },
    );
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const { runQuery, runMutation } = makeTurnCtx([
      { _id: "pending-terminal", threadId: "thread-1", order: 1, status: "pending" },
    ]);
    let primaryOutcome: unknown;
    runWithPrimaryCircuitBreakerMock.mockImplementationOnce(
      async (options: { primaryAgent: Agent; runAttempt: (agent: Agent) => Promise<unknown> }) => {
        primaryOutcome = await options.runAttempt(options.primaryAgent);
      },
    );

    const accumulator = await streamWithRetry(
      { runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx,
      { primaryAgent: agent, fallbackAgent: agent, ...baseStreamWithRetryArgs("claude") },
    );

    expect(primaryOutcome).toEqual({ done: true, success: false, errorClass: "Error" });
    expect(accumulator.toRow().terminalErrorClass).toBe("Error");
    expect(recordErrorMock).toHaveBeenCalledWith("Error");
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
    const { runQuery, runMutation } = makeTurnCtx([
      { _id: "msg-1", threadId: "thread-1", order: 1, status: "pending" },
    ]);

    await streamWithRetry({ runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("gemini"),
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        patch: { status: "failed", error: "transient_retry" },
      }),
    );
    expect(runMutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        patch: expect.objectContaining({ error: expect.stringContaining("high demand") }),
      }),
    );
  });

  it("atomically marks Claude overload failures as retrying", async () => {
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
    const { runQuery, runMutation } = makeTurnCtx([
      { _id: "pending-claude", threadId: "thread-1", order: 1, status: "pending" },
    ]);

    await streamWithRetry({ runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("claude"),
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "pending-claude",
        patch: { status: "failed", error: "transient_retry" },
      }),
    );
  });

  it("does not fail a message when onError is not called", async () => {
    const { agent } = makeSuccessAgent();
    const { runQuery, runMutation } = makeTurnCtx([]);

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
      expect.objectContaining({ patch: expect.objectContaining({ status: "failed" }) }),
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
    const { runQuery, runMutation } = makeTurnCtx([
      { _id: "pending-msg", threadId: "thread-1", order: 1, status: "pending" },
    ]);

    await streamWithRetry({ runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("gemini"),
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "pending-msg",
        patch: { status: "failed", error: "transient_retry" },
      }),
    );
  });

  it("atomically marks ECONNRESET stream errors as retrying", async () => {
    const econnresetError = new Error("Cannot connect to API: read ECONNRESET");
    const streamText = vi.fn(
      async (options: { onError?: (args: { error: unknown }) => Promise<void> }) => {
        await options.onError?.({ error: econnresetError });
        return { text: Promise.reject(econnresetError) };
      },
    );
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const { runQuery, runMutation } = makeTurnCtx([
      { _id: "pending-econnreset", threadId: "thread-1", order: 1, status: "pending" },
    ]);

    await streamWithRetry({ runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("gemini"),
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "pending-econnreset",
        patch: { status: "failed", error: "transient_retry" },
      }),
    );
  });

  it("persists a retry lease on the prompt without demoting terminal steps", async () => {
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
    const { runQuery, runMutation } = makeTurnCtx([
      { _id: "prompt-1", threadId: "thread-1", order: 1, status: "success" },
      { _id: "success-msg", threadId: "thread-1", order: 1, status: "success" },
      { _id: "failed-msg", threadId: "thread-1", order: 1, status: "failed" },
    ]);

    await streamWithRetry({ runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("gemini"),
    });

    expect(runMutation).toHaveBeenCalledWith(
      components.agent.messages.updateMessage,
      expect.objectContaining({
        messageId: "prompt-1",
        patch: { error: "transient_retry" },
      }),
    );
    expect(runMutation).not.toHaveBeenCalledWith(
      components.agent.messages.updateMessage,
      expect.objectContaining({
        messageId: "success-msg",
        patch: expect.objectContaining({ status: "failed" }),
      }),
    );
  });
});
