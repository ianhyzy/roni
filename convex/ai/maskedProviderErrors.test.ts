import { type Agent, saveMessage } from "@convex-dev/agent";
import { APICallError, type LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import {
  bindProviderErrorCapture,
  consumeCapturedError,
  createProviderErrorCapture,
  resetCapturedError,
} from "./byokErrors";
import { buildCoachAgentsForProvider, type CoachAgentPair } from "./coach";
import { PROVIDERS } from "./providers";
import { streamWithRetry } from "./resilience";

const runWithPrimaryCircuitBreakerMock = vi.hoisted(() => vi.fn());
const recordErrorMock = vi.hoisted(() => vi.fn());
let primaryOutcome: unknown;

vi.mock("@convex-dev/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/agent")>()),
  saveMessage: vi.fn(async () => undefined),
}));

vi.mock("./otel", () => ({
  runInRunSpan: async (
    _metadata: unknown,
    fn: (span: { runId: string; recordError: (error: string) => void }) => Promise<unknown>,
  ) => fn({ runId: "run-masked-provider", recordError: recordErrorMock }),
}));

vi.mock("./resilienceCircuitBreaker", () => ({
  runWithPrimaryCircuitBreaker: runWithPrimaryCircuitBreakerMock,
}));

function makeCtx() {
  const messages = [
    { _id: "prompt-1", threadId: "thread-1", order: 1, status: "success" },
    { _id: "failed-1", threadId: "thread-1", order: 1, status: "failed", error: "Error" },
  ];
  const runQuery = vi.fn(async (_reference: unknown, args: { messageIds?: string[] }) =>
    args.messageIds
      ? messages.filter((message) => args.messageIds?.includes(message._id))
      : { page: messages, isDone: true, continueCursor: "" },
  );
  const runMutation = vi.fn(
    async (_reference: unknown, args: { messageId: string; patch: object }) => {
      const message = messages.find((candidate) => candidate._id === args.messageId);
      if (message) Object.assign(message, args.patch);
    },
  );
  const notify = vi.fn(async () => undefined);
  return {
    ctx: {
      runQuery,
      runMutation,
      scheduler: { runAfter: notify },
    } as unknown as ActionCtx,
    messages,
    notify,
    runMutation,
  };
}

async function captureRejection(run: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    return await run();
  } catch (error) {
    return error;
  }
}

function rejectingStreamModel(error: Error) {
  return new MockLanguageModelV3({
    doStream: async () => {
      throw error;
    },
  });
}

function getChatModel(agents: CoachAgentPair) {
  const model = agents.tierModels.chat;
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    throw new Error("Expected a V3 language model");
  }
  return model;
}

function runCoachStream(ctx: ActionCtx, agents: CoachAgentPair) {
  return streamWithRetry(ctx, {
    primaryAgent: agents.primary,
    fallbackAgent: agents.fallback,
    primaryModelName: agents.primaryModelName,
    threadId: "thread-1",
    userId: "user-1",
    promptMessageId: "prompt-1",
    prompt: "hello",
    isByok: true,
    provider: "gemini",
    source: "chat",
    environment: "prod",
  });
}

describe("masked provider errors", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    primaryOutcome = undefined;
    runWithPrimaryCircuitBreakerMock.mockImplementation(
      async (options: { primaryAgent: Agent; runAttempt: (agent: Agent) => Promise<unknown> }) => {
        primaryOutcome = await options.runAttempt(options.primaryAgent);
      },
    );
  });

  it.each(["mask", "finish", "onError"] as const)("handles quota via %s", async (failurePath) => {
    const raw = "Your prepayment credits are depleted. Manage billing.";
    const providerError = new APICallError({
      message: "Error",
      url: "https://generativelanguage.googleapis.test/v1/models",
      requestBodyValues: {},
      statusCode: 400,
      responseBody: JSON.stringify({ error: { message: raw } }),
      isRetryable: false,
    });
    const model = rejectingStreamModel(providerError);
    vi.spyOn(PROVIDERS.gemini, "createLanguageModel").mockReturnValue(model);
    const agents = buildCoachAgentsForProvider({ provider: "gemini", apiKey: "user-key" });
    let downstreamError: unknown;
    const streamText = vi.fn(
      async (options: {
        onError?: (args: { error: unknown }) => unknown;
        onStepFinish: (step: never) => unknown;
      }) => {
        try {
          await getChatModel(agents).doStream({} as never);
        } catch (error) {
          downstreamError = error;
        }
        if (failurePath === "onError") {
          await options.onError?.({ error: new Error("An error occurred.") });
        }
        if (failurePath === "mask") throw new Error("An error occurred.");
        await options.onStepFinish({ finishReason: "error" } as never);
        return { text: Promise.resolve("") };
      },
    );
    vi.spyOn(agents.primary, "continueThread").mockResolvedValue({
      thread: { streamText },
    } as never);
    const { ctx, messages, notify, runMutation } = makeCtx();
    const accumulator = await runCoachStream(ctx, agents);
    expect(primaryOutcome).toEqual({
      done: true,
      success: false,
      errorClass: "byok_quota_exceeded",
    });
    expect(accumulator.toRow().terminalErrorClass).toBe("byok_quota_exceeded");
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(downstreamError).toMatchObject({ message: "byok_quota_exceeded" });
    expect(messages[1].error).toBe("Error");
    const observable = JSON.stringify({
      saved: vi.mocked(saveMessage).mock.calls,
      mutations: runMutation.mock.calls,
      notifications: notify.mock.calls,
      telemetry: [recordErrorMock.mock.calls, accumulator.toRow()],
    });
    expect(observable).toContain("Google Gemini billing");
    expect(observable).toContain("/settings");
    expect(observable).not.toContain(raw);
  });

  it("sanitizes generate rejections before they reach downstream code", async () => {
    const raw = "invalid_api_key secret-provider-detail";
    const capture = createProviderErrorCapture();
    const model = capture.wrapModel(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw Object.assign(new Error("Error"), { responseBody: raw });
        },
      }),
    );
    const downstreamError = await captureRejection(() => model.doGenerate({} as never));
    const firstCapture = capture.consume();
    const secondCapture = capture.consume();
    expect(downstreamError).toMatchObject({ message: "byok_key_invalid" });
    expect(firstCapture).toMatchObject({ message: "byok_key_invalid" });
    expect(secondCapture).toBeUndefined();
    expect(JSON.stringify([downstreamError, firstCapture])).not.toContain(raw);
  });

  it.each(["part", "rejection"] as const)("sanitizes mid-stream %s errors", async (failurePath) => {
    const raw = "private mid-stream provider detail";
    const providerStream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        if (failurePath === "rejection") {
          controller.error(new Error(raw));
          return;
        }
        controller.enqueue({ type: "error", error: new Error(raw) });
        controller.close();
      },
    });
    const capture = createProviderErrorCapture();
    const model = capture.wrapModel(
      new MockLanguageModelV3({ doStream: { stream: providerStream } }),
    );
    const result = await model.doStream({} as never);
    const reader = result.stream.getReader();
    const observed =
      failurePath === "part"
        ? (await reader.read()).value
        : await captureRejection(() => reader.read());
    const downstreamError =
      failurePath === "part" ? (observed as { error: unknown }).error : observed;
    expect(downstreamError).toMatchObject({ message: "byok_unknown_error" });
    expect(capture.consume()).toMatchObject({ message: "byok_unknown_error" });
    expect(String(downstreamError)).not.toContain(raw);
  });

  it("preserves transient classification so resilience retries", async () => {
    const raw = "private upstream outage detail";
    const model = rejectingStreamModel(Object.assign(new Error(raw), { status: 503 }));
    vi.spyOn(PROVIDERS.gemini, "createLanguageModel").mockReturnValue(model);
    const agents = buildCoachAgentsForProvider({ provider: "gemini", apiKey: "user-key" });
    const streamText = vi.fn(async () => {
      await getChatModel(agents).doStream({} as never);
    });
    vi.spyOn(agents.primary, "continueThread").mockResolvedValue({
      thread: { streamText },
    } as never);
    const { ctx } = makeCtx();
    const accumulator = await runCoachStream(ctx, agents);
    expect(primaryOutcome).toMatchObject({
      done: false,
      error: { message: "server error", status: 500 },
    });
    expect(accumulator.toRow().terminalErrorClass).toBeUndefined();
    expect(JSON.stringify(primaryOutcome)).not.toContain(raw);
  });

  it("keeps captures agent-scoped, one-shot, and reset between attempts", async () => {
    const captureA = createProviderErrorCapture();
    const captureB = createProviderErrorCapture();
    const agentA = {} as Agent;
    const agentB = {} as Agent;
    bindProviderErrorCapture(agentA, captureA);
    bindProviderErrorCapture(agentB, captureB);
    const modelA = captureA.wrapModel(
      new MockLanguageModelV3({
        doGenerate: async () => {
          throw new Error("private provider failure");
        },
      }),
    );
    await captureRejection(() => modelA.doGenerate({} as never));
    expect(consumeCapturedError(agentB)).toBeUndefined();
    expect(consumeCapturedError(agentA)).toMatchObject({ message: "byok_unknown_error" });
    expect(consumeCapturedError(agentA)).toBeUndefined();
    await captureRejection(() => modelA.doGenerate({} as never));
    resetCapturedError(agentA);
    expect(consumeCapturedError(agentA)).toBeUndefined();
  });

  it("does not replace an unrelated finalization failure", async () => {
    const model = rejectingStreamModel(Object.assign(new Error("quota secret"), { status: 429 }));
    vi.spyOn(PROVIDERS.gemini, "createLanguageModel").mockReturnValue(model);
    const agents = buildCoachAgentsForProvider({ provider: "gemini", apiKey: "user-key" });
    const streamText = vi.fn(async () => {
      await captureRejection(() => getChatModel(agents).doStream({} as never));
      throw new Error("Agent finalization failed");
    });
    vi.spyOn(agents.primary, "continueThread").mockResolvedValue({
      thread: { streamText },
    } as never);
    const { ctx } = makeCtx();
    const accumulator = await runCoachStream(ctx, agents);
    expect(primaryOutcome).toEqual({ done: true, success: false, errorClass: "Error" });
    expect(accumulator.toRow().terminalErrorClass).toBe("Error");
  });

  it("leaves house-key models unwrapped", async () => {
    const providerError = new Error("house-key provider detail");
    const model = rejectingStreamModel(providerError);
    vi.spyOn(PROVIDERS.gemini, "createLanguageModel").mockReturnValue(model);

    const agents = buildCoachAgentsForProvider({
      provider: "gemini",
      apiKey: "house-key",
      isHouseKey: true,
    });

    expect(agents.tierModels.chat).toBe(model);
    expect(await captureRejection(() => model.doStream({} as never))).toBe(providerError);
  });
});
