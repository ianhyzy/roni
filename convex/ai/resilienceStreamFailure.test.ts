import type { Agent } from "@convex-dev/agent";
import { saveMessage } from "@convex-dev/agent";
import type { StepResult, ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { streamWithRetry } from "./resilience";
import { RETRY_FINISHED_MESSAGE_ERROR, RETRYING_MESSAGE_ERROR } from "./resilienceReporting";

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
      async (options: { onStepFinish: (step: StepResult<ToolSet>) => Promise<void> | void }) => {
        await options.onStepFinish(responseFailedStep());
        return { text: Promise.resolve(""), savedMessages: [messages[1]] };
      },
    );
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const messages: Array<{
      _id: string;
      threadId: string;
      order: number;
      status: "pending" | "failed" | "success";
      error?: string;
      finishReason?: "error";
    }> = [
      {
        _id: "prompt-1",
        threadId: "thread-1",
        order: 1,
        status: "success",
        error: undefined as string | undefined,
      },
      {
        _id: "provider-error-message",
        threadId: "thread-1",
        order: 1,
        status: "success",
        finishReason: "error",
      },
    ];
    const runQuery = vi.fn(
      async (
        _reference: unknown,
        queryArgs: { messageIds?: string[]; statuses?: Array<string> },
      ) => {
        if (queryArgs.messageIds) {
          return [messages[0]];
        }
        return {
          page: queryArgs.statuses
            ? messages.filter((message) => queryArgs.statuses?.includes(message.status))
            : messages,
        };
      },
    );
    const runMutation = vi.fn(
      async (_reference: unknown, mutationArgs: { messageId: string; patch: object }) => {
        const message = messages.find((candidate) => candidate._id === mutationArgs.messageId);
        if (message) Object.assign(message, mutationArgs.patch);
      },
    );
    const runAction = vi.fn(async () => undefined);

    const accumulator = await streamWithRetry(
      { runQuery, runMutation, runAction } as unknown as ActionCtx,
      {
        primaryAgent: agent,
        fallbackAgent: agent,
        primaryModelName: "gemini-2.5-flash",
        threadId: "thread-1",
        promptMessageId: "prompt-1",
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
    expect(runMutation).toHaveBeenCalledWith(components.agent.messages.updateMessage, {
      messageId: "provider-error-message",
      patch: { status: "failed", error: RETRYING_MESSAGE_ERROR },
    });
    expect(runMutation).toHaveBeenCalledWith(components.agent.messages.updateMessage, {
      messageId: "prompt-1",
      patch: { error: RETRY_FINISHED_MESSAGE_ERROR },
    });
  });

  it("surfaces non-thrown provider finish errors as BYOK messages", async () => {
    const messages: Array<{
      _id: string;
      threadId: string;
      order: number;
      status: "failed" | "success";
      error?: string;
      finishReason?: "error";
    }> = [
      { _id: "prompt-1", threadId: "thread-1", order: 1, status: "success" },
      {
        _id: "provider-error-message",
        threadId: "thread-1",
        order: 1,
        status: "success",
        finishReason: "error",
      },
    ];
    const streamText = vi.fn(
      async (options: { onStepFinish: (step: StepResult<ToolSet>) => Promise<void> | void }) => {
        await options.onStepFinish(responseFailedStep());
        return { text: Promise.resolve(""), savedMessages: [messages[1]] };
      },
    );
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const runQuery = vi.fn(
      async (_reference: unknown, args: { messageIds?: string[]; statuses?: string[] }) =>
        args.messageIds
          ? [messages[0]]
          : {
              page: args.statuses
                ? messages.filter((message) => args.statuses?.includes(message.status))
                : messages,
              isDone: true,
              continueCursor: "",
            },
    );
    const runMutation = vi.fn(
      async (_reference: unknown, args: { messageId: string; patch: object }) => {
        const message = messages.find((candidate) => candidate._id === args.messageId);
        if (message) Object.assign(message, args.patch);
      },
    );
    const scheduleNotification = vi.fn(async () => {
      throw new Error("Discord unavailable");
    });

    const accumulator = await streamWithRetry(
      {
        runQuery,
        runMutation,
        runAction: vi.fn(),
        scheduler: { runAfter: scheduleNotification },
      } as unknown as ActionCtx,
      {
        primaryAgent: agent,
        fallbackAgent: agent,
        primaryModelName: "gpt-5.4",
        threadId: "thread-1",
        promptMessageId: "prompt-1",
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
      components.agent.messages.updateMessage,
      expect.objectContaining({
        messageId: "provider-error-message",
        patch: { status: "failed", error: RETRYING_MESSAGE_ERROR },
      }),
    );
    expect(saveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        promptMessageId: "prompt-1",
        message: expect.objectContaining({
          content: expect.stringContaining("OpenAI returned an unexpected error"),
        }),
      }),
    );
    expect(scheduleNotification).toHaveBeenCalledTimes(1);
    expect(scheduleNotification).toHaveBeenCalledWith(0, expect.anything(), {
      source: "streamWithRetry",
      message: "byok_unknown_error on openai",
      userId: "user-1",
    });
    expect(recordErrorMock).toHaveBeenCalledWith("byok_unknown_error");
  });

  it("keeps the durable retry lease until the circuit-breaker chain is terminal", async () => {
    runWithPrimaryCircuitBreakerMock.mockImplementationOnce(
      async (options: {
        finalizePending: (reason: string) => Promise<void>;
        markRetrying: () => Promise<void>;
      }) => {
        await options.finalizePending(RETRYING_MESSAGE_ERROR);
        await options.markRetrying();
      },
    );
    const messages: Array<{
      _id: string;
      threadId: string;
      order: number;
      status: "pending" | "failed" | "success";
      error?: string;
    }> = [
      {
        _id: "failed-attempt",
        threadId: "thread-1",
        order: 1,
        status: "failed",
        error: "provider_overload",
      },
      {
        _id: "prompt-1",
        threadId: "thread-1",
        order: 1,
        status: "success",
        error: undefined as string | undefined,
      },
    ];
    const runQuery = vi.fn(
      async (
        _reference: unknown,
        args: {
          messageIds?: string[];
          statuses?: Array<"pending" | "failed" | "success">;
        },
      ) => {
        if (args.messageIds) {
          return [messages.find((message) => message._id === "prompt-1")];
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
      async (_reference: unknown, args: { messageId: string; patch: object }) => {
        const message = messages.find((candidate) => candidate._id === args.messageId);
        if (message) Object.assign(message, args.patch);
      },
    );

    await streamWithRetry({ runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx, {
      primaryAgent: {} as Agent,
      fallbackAgent: {} as Agent,
      primaryModelName: "gemini-2.5-flash",
      threadId: "thread-1",
      promptMessageId: "prompt-1",
      userId: "user-1",
      prompt: "hello",
      isByok: false,
      provider: "gemini",
      source: "chat",
      environment: "prod",
    });

    expect(runMutation).toHaveBeenNthCalledWith(1, components.agent.messages.updateMessage, {
      messageId: "prompt-1",
      patch: { error: RETRYING_MESSAGE_ERROR },
    });
    expect(runMutation).toHaveBeenNthCalledWith(2, components.agent.messages.updateMessage, {
      messageId: "prompt-1",
      patch: { error: RETRY_FINISHED_MESSAGE_ERROR },
    });
  });
});

// onError pre-emptive finalization tests live in resilienceOnError.test.ts
