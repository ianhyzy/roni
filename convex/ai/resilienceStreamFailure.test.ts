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
