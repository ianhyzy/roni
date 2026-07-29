import type { Agent } from "@convex-dev/agent";
import { saveMessage } from "@convex-dev/agent";
import { APICallError } from "@ai-sdk/provider";
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

    expect(accumulator.toRow()).toMatchObject({
      finishReason: "error",
      terminalErrorClass: undefined,
    });
    expect(saveMessage).not.toHaveBeenCalled();
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

  it("routes non-thrown BYOK provider finish errors to transient handling", async () => {
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
    let primaryOutcome: unknown;
    runWithPrimaryCircuitBreakerMock.mockImplementationOnce(
      async (options: { primaryAgent: Agent; runAttempt: (agent: Agent) => Promise<unknown> }) => {
        primaryOutcome = await options.runAttempt(options.primaryAgent);
      },
    );

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
      terminalErrorClass: undefined,
    });
    expect(primaryOutcome).toMatchObject({
      done: false,
      error: expect.objectContaining({ message: "provider_response_failed" }),
    });
    expect(saveMessage).not.toHaveBeenCalled();
    expect(scheduleNotification).not.toHaveBeenCalled();
  });

  it("preserves specific BYOK errors reported by the stream", async () => {
    const rawProviderMessage = "private-provider-detail-71c8";
    const quotaError = new APICallError({
      message: rawProviderMessage,
      url: "https://example.test/v1/messages",
      requestBodyValues: {},
      statusCode: 429,
      isRetryable: false,
    });
    const streamText = vi.fn(
      async (options: {
        onError?: (args: { error: unknown }) => Promise<void>;
        onStepFinish: (step: StepResult<ToolSet>) => Promise<void> | void;
      }) => {
        await options.onError?.({ error: quotaError });
        await options.onStepFinish(responseFailedStep());
        return { text: Promise.resolve("") };
      },
    );
    const agent = {
      continueThread: vi.fn(async () => ({ thread: { streamText } })),
    } as unknown as Agent;
    const runQuery = vi.fn(async (_reference: unknown, args: { messageIds?: string[] }) =>
      args.messageIds
        ? [{ _id: "prompt-1", threadId: "thread-1", order: 1, status: "success" }]
        : { page: [], isDone: true, continueCursor: "" },
    );
    const scheduleNotification = vi.fn(async () => undefined);
    const runMutation = vi.fn();

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
        primaryModelName: "gemini-2.5-flash",
        threadId: "thread-1",
        promptMessageId: "prompt-1",
        userId: "user-1",
        prompt: "hello",
        isByok: true,
        provider: "gemini",
        source: "chat",
        environment: "prod",
      },
    );

    expect(accumulator.toRow().terminalErrorClass).toBe("byok_quota_exceeded");
    expect(saveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        message: expect.objectContaining({ content: expect.stringContaining("over quota") }),
      }),
    );
    expect(scheduleNotification).toHaveBeenCalledWith(
      0,
      expect.anything(),
      expect.objectContaining({ message: "byok_quota_exceeded on gemini" }),
    );
    expect(
      JSON.stringify({
        messages: vi.mocked(saveMessage).mock.calls,
        mutations: runMutation.mock.calls,
        notifications: scheduleNotification.mock.calls,
      }),
    ).not.toContain(rawProviderMessage);
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
