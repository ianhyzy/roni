import type { Agent } from "@convex-dev/agent";
import type { PrepareStepFunction, ToolSet } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { ProviderId } from "./providers";
import { streamWithRetry } from "./resilience";

const runWithPrimaryCircuitBreakerMock = vi.hoisted(() => vi.fn());

vi.mock("./otel", () => ({
  buildCoachTelemetryConfig: () => ({ isEnabled: false }),
  runInRunSpan: async (
    _metadata: unknown,
    fn: (span: { runId: string; recordError: (error: string) => void }) => Promise<unknown>,
  ) => fn({ runId: "run-routing-options", recordError: vi.fn() }),
}));

vi.mock("./resilienceCircuitBreaker", () => ({
  runWithPrimaryCircuitBreaker: runWithPrimaryCircuitBreakerMock,
}));

function makeSuccessAgent(onStreamText?: (options: Record<string, unknown>) => void): {
  agent: Agent;
  captureStreamTextOptions: () => Record<string, unknown> | undefined;
} {
  let captured: Record<string, unknown> | undefined;
  const streamText = vi.fn(async (options: Record<string, unknown>) => {
    captured = options;
    onStreamText?.(options);
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

describe("BYOK budget policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runWithPrimaryCircuitBreakerMock.mockImplementation(
      async (options: { primaryAgent: Agent; runAttempt: unknown }) => {
        const runAttempt = options.runAttempt as (agent: Agent) => Promise<unknown>;
        return await runAttempt(options.primaryAgent);
      },
    );
  });

  it("omits the budget stop condition when the guard is disabled", async () => {
    let expensiveStepShouldStop: boolean | undefined;
    const { agent, captureStreamTextOptions } = makeSuccessAgent((options) => {
      const stopWhen = options.stopWhen;
      if (typeof stopWhen !== "function") throw new Error("Expected only the step-count guard");
      expensiveStepShouldStop = (
        stopWhen as (args: { steps: Array<Record<string, unknown>> }) => boolean
      )({
        steps: [
          {
            usage: { inputTokens: 100_000, outputTokens: 20_000 },
            model: { provider: "openai", modelId: "gpt-5.4" },
          },
        ],
      });
    });
    const ctx = makePromptCtx();

    await streamWithRetry(ctx, {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("openai"),
      isByok: true,
      budgetPolicy: { kind: "disabled" },
    });

    expect(Array.isArray(captureStreamTextOptions()?.stopWhen)).toBe(false);
    expect(expensiveStepShouldStop).toBe(false);
    expect(ctx.runMutation).not.toHaveBeenCalledWith(
      internal.aiUsage.recordBudgetStop,
      expect.anything(),
    );
  });

  it("installs a stop condition with the configured provider limit", async () => {
    const { agent, captureStreamTextOptions } = makeSuccessAgent();

    await streamWithRetry(makePromptCtx(), {
      primaryAgent: agent,
      fallbackAgent: agent,
      ...baseStreamWithRetryArgs("openai"),
      isByok: true,
      budgetPolicy: { kind: "limit", maxAttemptUsd: 0.2 },
    });

    const stopWhen = captureStreamTextOptions()?.stopWhen;
    expect(Array.isArray(stopWhen)).toBe(true);
    if (!Array.isArray(stopWhen)) throw new Error("Expected budget stop conditions");
    const conditions = stopWhen as Array<(args: { steps: unknown[] }) => boolean>;
    const steps = [
      {
        usage: { inputTokens: 10_000, outputTokens: 2_000 },
        model: { provider: "openai", modelId: "gpt-5.4" },
      },
      {
        usage: { inputTokens: 5_000, outputTokens: 3_000 },
        model: { provider: "openai", modelId: "gpt-5.4" },
      },
    ];

    expect(conditions.some((condition) => condition({ steps }))).toBe(false);
  });

  it("starts a fresh budget guard for each retry and fallback attempt", async () => {
    const primaryAttempts: Array<Record<string, unknown>> = [];
    const fallbackAttempts: Array<Record<string, unknown>> = [];
    const { agent: primaryAgent } = makeSuccessAgent((options) => primaryAttempts.push(options));
    const { agent: fallbackAgent } = makeSuccessAgent((options) => fallbackAttempts.push(options));
    runWithPrimaryCircuitBreakerMock.mockImplementationOnce(
      async (options: { primaryAgent: Agent; fallbackAgent: Agent; runAttempt: unknown }) => {
        const runAttempt = options.runAttempt as (agent: Agent) => Promise<unknown>;
        await runAttempt(options.primaryAgent);
        await runAttempt(options.primaryAgent);
        return await runAttempt(options.fallbackAgent);
      },
    );

    await streamWithRetry(makePromptCtx(), {
      primaryAgent,
      fallbackAgent,
      ...baseStreamWithRetryArgs("openai"),
      isByok: true,
      budgetPolicy: { kind: "limit", maxAttemptUsd: 0.1 },
    });

    const firstPrimaryConditions = primaryAttempts[0]?.stopWhen;
    const retryConditions = primaryAttempts[1]?.stopWhen;
    const fallbackConditions = fallbackAttempts[0]?.stopWhen;
    if (
      !Array.isArray(firstPrimaryConditions) ||
      !Array.isArray(retryConditions) ||
      !Array.isArray(fallbackConditions)
    ) {
      throw new Error("Expected per-attempt budget stop conditions");
    }
    const expensiveSteps = [
      {
        usage: { inputTokens: 20_000, outputTokens: 4_000 },
        model: { provider: "openai", modelId: "gpt-5.4" },
      },
    ];
    const inexpensiveSteps = [
      {
        usage: { inputTokens: 1_000, outputTokens: 100 },
        model: { provider: "openai", modelId: "gpt-5.4" },
      },
    ];
    const firstPrimary = firstPrimaryConditions as Array<(args: { steps: unknown[] }) => boolean>;
    const retry = retryConditions as Array<(args: { steps: unknown[] }) => boolean>;
    const fallback = fallbackConditions as Array<(args: { steps: unknown[] }) => boolean>;

    expect(firstPrimary.some((condition) => condition({ steps: expensiveSteps }))).toBe(true);
    expect(retry.some((condition) => condition({ steps: inexpensiveSteps }))).toBe(false);
    expect(fallback.some((condition) => condition({ steps: inexpensiveSteps }))).toBe(false);
  });
});
