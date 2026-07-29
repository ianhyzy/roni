import type { Agent } from "@convex-dev/agent";
import type { PrepareStepFunction, ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import type { ProviderId } from "./providers";
import { streamWithRetry } from "./resilience";

const runWithPrimaryCircuitBreakerMock = vi.hoisted(() => vi.fn());

vi.mock("./otel", () => ({
  runInRunSpan: async (
    _metadata: unknown,
    fn: (span: { runId: string; recordError: (error: string) => void }) => Promise<unknown>,
  ) => fn({ runId: "run-routing-options", recordError: vi.fn() }),
}));

vi.mock("./resilienceCircuitBreaker", () => ({
  runWithPrimaryCircuitBreaker: runWithPrimaryCircuitBreakerMock,
}));

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
    promptMessageId: "prompt-1",
    userId: "user-1",
    prompt: "hello",
    isByok: false,
    provider,
    source: "chat" as const,
    environment: "dev" as const,
  };
}

function makePromptCtx(): ActionCtx {
  const prompt = {
    _id: "prompt-1",
    threadId: "thread-1",
    order: 1,
    status: "success",
    error: undefined as string | undefined,
  };
  const runQuery = vi.fn(
    async (_reference: unknown, args: { messageIds?: string[]; statuses?: string[] }) =>
      args.messageIds
        ? [prompt]
        : {
            page: !args.statuses || args.statuses.includes(prompt.status) ? [prompt] : [],
            isDone: true,
            continueCursor: "",
          },
  );
  const runMutation = vi.fn(
    async (_reference: unknown, args: { messageId: string; patch: object }) => {
      if (args.messageId === prompt._id) Object.assign(prompt, args.patch);
    },
  );
  return { runQuery, runMutation, runAction: vi.fn() } as unknown as ActionCtx;
}

describe("streamWithRetry prepareStep routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the fallback prepareStep when the circuit breaker runs the fallback agent", async () => {
    const { agent: primaryAgent } = makeSuccessAgent();
    const { agent: fallbackAgent, captureStreamTextOptions } = makeSuccessAgent();
    const primaryPrepareStep = vi.fn(() => undefined) as PrepareStepFunction<ToolSet>;
    const fallbackPrepareStep = vi.fn(() => undefined) as PrepareStepFunction<ToolSet>;
    runWithPrimaryCircuitBreakerMock.mockImplementationOnce(
      async (options: { fallbackAgent: Agent; runAttempt: unknown }) => {
        const runAttempt = options.runAttempt as (agent: Agent) => Promise<unknown>;
        return await runAttempt(options.fallbackAgent);
      },
    );

    await streamWithRetry(makePromptCtx(), {
      primaryAgent,
      fallbackAgent,
      prepareStep: primaryPrepareStep,
      fallbackPrepareStep,
      ...baseStreamWithRetryArgs("gemini"),
    });

    expect(captureStreamTextOptions()?.prepareStep).toBe(fallbackPrepareStep);
  });
});

describe("Gemini thinking minimized via providerOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runWithPrimaryCircuitBreakerMock.mockImplementation(
      async (options: { primaryAgent: Agent; runAttempt: unknown }) => {
        const runAttempt = options.runAttempt as (agent: Agent) => Promise<unknown>;
        return await runAttempt(options.primaryAgent);
      },
    );
  });

  it("passes minimal thinking providerOptions for Gemini 3", async () => {
    const { agent, captureStreamTextOptions } = makeSuccessAgent();

    await streamWithRetry(makePromptCtx(), {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("gemini"),
    });

    expect(captureStreamTextOptions()?.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingLevel: "minimal" } },
    });
  });

  it.each<ProviderId>(["claude", "openai", "openrouter"])(
    "does not add Google providerOptions for %s provider",
    async (provider) => {
      const { agent, captureStreamTextOptions } = makeSuccessAgent();

      await streamWithRetry(makePromptCtx(), {
        primaryAgent: agent,
        fallbackAgent: agent,
        ...baseStreamWithRetryArgs(provider),
      });

      expect(captureStreamTextOptions()?.providerOptions).toBeUndefined();
    },
  );
});
