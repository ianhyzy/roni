import type { Agent } from "@convex-dev/agent";
import { saveMessage } from "@convex-dev/agent";
import type { StepResult, ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
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

function makeCircuitBreakerMock() {
  return async (options: { primaryAgent: Agent; runAttempt: (agent: Agent) => Promise<unknown> }) =>
    options.runAttempt(options.primaryAgent);
}

describe("streamWithRetry provider response failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runWithPrimaryCircuitBreakerMock.mockImplementation(makeCircuitBreakerMock());
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

describe("onError pre-emptive finalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runWithPrimaryCircuitBreakerMock.mockImplementation(makeCircuitBreakerMock());
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
      primaryModelName: "gemini-2.0-flash",
      threadId: "thread-1",
      userId: "user-1",
      prompt: "hello",
      isByok: false,
      provider: "gemini",
      source: "chat",
      environment: "dev",
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
      primaryModelName: "gemini-2.0-flash",
      threadId: "thread-1",
      userId: "user-1",
      prompt: "hi",
      isByok: false,
      provider: "gemini",
      source: "chat",
      environment: "dev",
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
      primaryModelName: "claude-sonnet-4-6",
      threadId: "thread-3",
      userId: "user-1",
      prompt: "hi",
      isByok: false,
      provider: "claude",
      source: "chat",
      environment: "dev",
    });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messageId: "pending-claude",
        result: { status: "failed", error: "provider_overload" },
      }),
    );
  });

  it("is safe when onError is not provided by the agent library", async () => {
    // Ensure we don't crash if the SDK doesn't call onError (happy path).
    const streamText = vi.fn(async () => ({ text: Promise.resolve("response text") }));
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const runQuery = vi.fn(async () => ({ page: [] }));
    const runMutation = vi.fn(async () => undefined);

    const accumulator = await streamWithRetry(
      { runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx,
      {
        primaryAgent: agent,
        fallbackAgent: agent,
        primaryModelName: "gemini-2.0-flash",
        threadId: "thread-4",
        userId: "user-1",
        prompt: "hello",
        isByok: false,
        provider: "gemini",
        source: "chat",
        environment: "dev",
      },
    );

    expect(accumulator.toRow().finishReason).not.toBe("error");
    expect(runMutation).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ result: expect.objectContaining({ status: "failed" }) }),
    );
  });
});
