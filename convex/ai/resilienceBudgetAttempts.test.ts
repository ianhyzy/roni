import type { Agent } from "@convex-dev/agent";
import { APICallError } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import { streamWithRetry } from "./resilience";

vi.mock("./otel", () => ({
  buildCoachTelemetryConfig: () => ({ isEnabled: false }),
  runInRunSpan: async (
    _metadata: unknown,
    fn: (span: { runId: string; recordError: (error: string) => void }) => Promise<unknown>,
  ) => fn({ runId: "run-budget-attempts", recordError: vi.fn() }),
}));

type StreamOptions = Record<string, unknown>;
type StopCondition = (args: { steps: unknown[] }) => boolean;

function getStopConditions(options: StreamOptions | undefined): StopCondition[] {
  if (!Array.isArray(options?.stopWhen)) {
    throw new Error("Expected the step-count and budget stop conditions");
  }
  return options.stopWhen as StopCondition[];
}

function transientProviderError(attempt: number): APICallError {
  return new APICallError({
    message: `provider unavailable on attempt ${attempt}`,
    url: "https://provider.test/v1/messages",
    requestBodyValues: {},
    statusCode: 503,
    isRetryable: true,
  });
}

function makePromptContext(): ActionCtx {
  const prompt = {
    _id: "prompt-1",
    threadId: "thread-1",
    order: 1,
    status: "success",
    error: undefined as string | undefined,
  };
  let primaryFailureCount = 0;
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
  const runMutation = vi.fn(async (_reference: unknown, args: Record<string, unknown>) => {
    if (typeof args.messageId === "string" && args.patch && typeof args.patch === "object") {
      Object.assign(prompt, args.patch);
      return null;
    }
    if (typeof args.errorClass === "string") {
      primaryFailureCount += 1;
      return {
        opened: false,
        openReason: null,
        recentFailures: primaryFailureCount,
        recentFailedCostUsd: 0,
      };
    }
    if (typeof args.provider === "string" && typeof args.runId === "string") {
      return { route: "primary", reason: "closed" };
    }
    return null;
  });
  return {
    runQuery,
    runMutation,
    runAction: vi.fn(),
    scheduler: { runAfter: vi.fn(async () => undefined) },
  } as unknown as ActionCtx;
}

describe("BYOK budget thresholds across retries", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts fresh guards through the real transient retry and fallback flow", async () => {
    vi.useFakeTimers();
    const primaryAttempts: StreamOptions[] = [];
    const fallbackAttempts: StreamOptions[] = [];
    const primaryStreamText = vi.fn(async (options: StreamOptions) => {
      primaryAttempts.push(options);
      return { text: Promise.reject(transientProviderError(primaryAttempts.length)) };
    });
    const fallbackStreamText = vi.fn(async (options: StreamOptions) => {
      fallbackAttempts.push(options);
      return { text: Promise.resolve("") };
    });
    const primaryAgent = {
      continueThread: vi.fn(async () => ({ thread: { streamText: primaryStreamText } })),
    } as unknown as Agent;
    const fallbackAgent = {
      continueThread: vi.fn(async () => ({ thread: { streamText: fallbackStreamText } })),
    } as unknown as Agent;

    const flow = streamWithRetry(makePromptContext(), {
      primaryAgent,
      fallbackAgent,
      primaryModelName: "gpt-5.4",
      threadId: "thread-1",
      promptMessageId: "prompt-1",
      userId: "user-1",
      prompt: "hello",
      isByok: true,
      budgetPolicy: { kind: "limit", maxAttemptUsd: 0.1 },
      provider: "openai",
      source: "chat",
      environment: "dev",
    });
    await vi.runAllTimersAsync();
    const accumulator = await flow;

    expect(primaryStreamText).toHaveBeenCalledTimes(2);
    expect(fallbackStreamText).toHaveBeenCalledOnce();
    expect(accumulator.toRow()).toMatchObject({
      retryCount: 2,
      fallbackReason: "transient_exhaustion",
    });

    const firstPrimary = getStopConditions(primaryAttempts[0]);
    const retry = getStopConditions(primaryAttempts[1]);
    const fallback = getStopConditions(fallbackAttempts[0]);
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

    expect(firstPrimary.some((condition) => condition({ steps: expensiveSteps }))).toBe(true);
    expect(retry.some((condition) => condition({ steps: inexpensiveSteps }))).toBe(false);
    expect(retry.some((condition) => condition({ steps: expensiveSteps }))).toBe(true);
    expect(fallback.some((condition) => condition({ steps: inexpensiveSteps }))).toBe(false);
    expect(fallback.some((condition) => condition({ steps: expensiveSteps }))).toBe(true);
  });
});
