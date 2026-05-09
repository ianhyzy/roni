import type { Agent } from "@convex-dev/agent";
import { saveMessage } from "@convex-dev/agent";
import type { StepResult, ToolSet } from "ai";
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
  ) => fn({ runId: "run-response-failed", recordError: recordErrorMock }),
}));

vi.mock("./resilienceCircuitBreaker", () => ({
  runWithPrimaryCircuitBreaker: runWithPrimaryCircuitBreakerMock,
}));

function responseFailedStep(): StepResult<ToolSet> {
  return {
    finishReason: "error",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    toolCalls: [],
    toolResults: [],
    response: {
      id: "resp_failed",
      model: {
        provider: "openai.responses",
        modelId: "gpt-5.4",
      },
      timestamp: new Date(0),
    },
    model: {
      provider: "openai.responses",
      modelId: "gpt-5.4",
    },
    stepNumber: 0,
  } as unknown as StepResult<ToolSet>;
}

describe("streamWithRetry provider response failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runWithPrimaryCircuitBreakerMock.mockImplementation(
      async (options: { primaryAgent: Agent; runAttempt: unknown }) => {
        const runAttempt = options.runAttempt as (agent: Agent) => Promise<unknown>;
        return await runAttempt(options.primaryAgent);
      },
    );
  });

  it("treats non-thrown provider finish errors as transient for non-BYOK users", async () => {
    // When the AI SDK finishes a step with finishReason:"error" but does not throw
    // (the error is embedded in the stream rather than propagated as an HTTP error),
    // non-BYOK users must get a transient outcome so the circuit-breaker retry/fallback
    // path fires — not a dead-end terminal error with a generic "I'm having trouble" message.
    const streamText = vi.fn(
      async (options: { onStepFinish: (step: StepResult<ToolSet>) => void }) => {
        options.onStepFinish(responseFailedStep());
        return { text: Promise.resolve("") };
      },
    );
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const runQuery = vi.fn(async () => ({
      page: [{ _id: "pending-message", status: "pending" }],
    }));
    const runMutation = vi.fn(async () => undefined);
    const runAction = vi.fn(async () => undefined);

    const accumulator = await streamWithRetry(
      { runQuery, runMutation, runAction } as unknown as ActionCtx,
      {
        primaryAgent: agent,
        fallbackAgent: agent,
        primaryModelName: "gemini-3-flash-preview",
        threadId: "thread-1",
        userId: "user-1",
        prompt: "hello",
        isByok: false,
        provider: "gemini",
        source: "chat",
        environment: "prod",
      },
    );

    // The error is transient: no terminal error class is set, and the circuit
    // breaker receives { done: false } so it can retry with the fallback agent.
    expect(accumulator.toRow()).toMatchObject({
      finishReason: "error",
      terminalErrorClass: undefined,
    });
    // No user-facing error message saved (circuit breaker handles retry/fallback).
    expect(saveMessage).not.toHaveBeenCalled();
    // No Discord notification for a transient signal.
    expect(runAction).not.toHaveBeenCalled();
    // No explicit finalizeMessage call from our layer (circuit breaker will finalize on retry).
    expect(runMutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: expect.objectContaining({ status: "failed" }) }),
    );
  });

  it("surfaces non-thrown provider finish errors as BYOK messages", async () => {
    const streamText = vi.fn(
      async (options: { onStepFinish: (step: StepResult<ToolSet>) => void }) => {
        options.onStepFinish(responseFailedStep());
        return { text: Promise.resolve("") };
      },
    );
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const runQuery = vi.fn(async () => ({
      page: [{ _id: "pending-message", status: "pending" }],
    }));
    const runMutation = vi.fn(async () => undefined);
    const runAction = vi.fn(async () => undefined);

    const accumulator = await streamWithRetry(
      { runQuery, runMutation, runAction } as unknown as ActionCtx,
      {
        primaryAgent: agent,
        fallbackAgent: agent,
        primaryModelName: "gpt-5.4",
        threadId: "thread-1",
        userId: "user-1",
        prompt: "hello",
        isByok: true,
        provider: "openai",
        source: "chat",
        environment: "prod",
      },
    );

    expect(accumulator.toRow()).toMatchObject({
      finishReason: "error",
      terminalErrorClass: "byok_unknown_error",
    });
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "pending-message",
        result: { status: "failed", error: "byok_unknown_error" },
      }),
    );
    expect(saveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        message: expect.objectContaining({
          content: expect.stringContaining("OpenAI returned an unexpected error"),
        }),
      }),
    );
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(recordErrorMock).toHaveBeenCalledWith("byok_unknown_error");
  });
});

function makeSuccessAgent(): {
  agent: Agent;
  captureStreamTextOptions: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const streamText = vi.fn(async (options: Record<string, unknown>) => {
    captured = options;
    return { text: Promise.resolve("") };
  });
  const agent = {
    continueThread: vi.fn(async () => ({ thread: { streamText } })),
  } as unknown as Agent;
  return { agent, captureStreamTextOptions: () => captured };
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

describe("Gemini thinking disabled via providerOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runWithPrimaryCircuitBreakerMock.mockImplementation(
      async (options: { primaryAgent: Agent; runAttempt: unknown }) => {
        const runAttempt = options.runAttempt as (agent: Agent) => Promise<unknown>;
        return await runAttempt(options.primaryAgent);
      },
    );
  });

  it("passes thinkingBudget: 0 providerOptions for Gemini to prevent thought_signature errors", async () => {
    const { agent, captureStreamTextOptions } = makeSuccessAgent();
    const ctx = {
      runQuery: vi.fn(async () => ({ page: [] })),
      runMutation: vi.fn(async () => undefined),
      runAction: vi.fn(async () => undefined),
    } as unknown as ActionCtx;

    await streamWithRetry(ctx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("gemini"),
    });

    expect(captureStreamTextOptions()?.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingBudget: 0 } },
    });
  });

  it.each<ProviderId>(["claude", "openai", "openrouter"])(
    "does not add Google providerOptions for %s provider",
    async (provider) => {
      const { agent, captureStreamTextOptions } = makeSuccessAgent();
      const ctx = {
        runQuery: vi.fn(async () => ({ page: [] })),
        runMutation: vi.fn(async () => undefined),
        runAction: vi.fn(async () => undefined),
      } as unknown as ActionCtx;

      await streamWithRetry(ctx, {
        primaryAgent: agent,
        fallbackAgent: agent,
        ...baseStreamWithRetryArgs(provider),
      });

      expect(captureStreamTextOptions()?.providerOptions).toBeUndefined();
    },
  );
});

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
});
