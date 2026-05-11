"use node";

import type { Agent } from "@convex-dev/agent";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { saveMessage } from "@convex-dev/agent";
import { stepCountIs, type StepResult, type TelemetrySettings, type ToolSet } from "ai";
import { components, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { budgetCapStopCondition, type BudgetCapTrip } from "./budgetCap";
import { COACH_MAX_STEPS } from "./coach";
import { type ProviderId } from "./providers";
import { type AttemptOutcome, runWithPrimaryCircuitBreaker } from "./resilienceCircuitBreaker";
import { type AccumulatorInit, RunAccumulator } from "./runTelemetry";
import { classifyByokError } from "./byokErrors";
import { runInRunSpan } from "./otel";
import { isQuotaError, isTransientError } from "./transientErrors";
import {
  getFinalizeCodeForError,
  safeFinalizePending,
  safeReportError,
  safeTryReportByok,
} from "./resilienceReporting";

export { getFinalizeCodeForError } from "./resilienceReporting";
const BUDGET_CAP_MESSAGE =
  "This is getting expensive on your API key, so I'm simplifying here. Ask a narrower follow-up if you want me to keep going.";
const MAX_OUTPUT_TOKENS = 4096;
const RETRY_DELAY_MS = 3000;

interface StreamWithRetryArgs {
  primaryAgent: Agent;
  fallbackAgent: Agent;
  primaryModelName: string;
  threadId: string;
  userId: string;
  prompt?: string | Array<ModelMessage>;
  promptMessageId?: string;
  isByok: boolean;
  provider: ProviderId;
  source: "chat" | "approval_continuation";
  environment: "dev" | "prod";
  release?: string;
  promptVersion?: string;
  hasImages?: boolean;
  scheduledAt?: number;
  processingStartedAt?: number;
  retrievalEnabled?: boolean;
}

type PromptArgs =
  | { prompt: string | Array<ModelMessage>; maxOutputTokens: number }
  | { promptMessageId: string; maxOutputTokens: number }
  | { promptMessageId: string; prompt: Array<ModelMessage>; maxOutputTokens: number };

const STREAM_OPTIONS = {
  saveStreamDeltas: { chunking: "word" as const, throttleMs: 100 },
};

// Convex actions have a 600s hard cap; budget 180s per attempt so 3 fit.
const ATTEMPT_TIMEOUT_MS = 180_000;

export async function streamWithRetry(
  ctx: ActionCtx,
  args: StreamWithRetryArgs,
): Promise<RunAccumulator> {
  const {
    primaryAgent,
    fallbackAgent,
    primaryModelName,
    threadId,
    userId,
    isByok,
    provider,
    source,
    environment,
    release,
    promptVersion,
    hasImages,
    scheduledAt,
    processingStartedAt,
    retrievalEnabled,
  } = args;
  const promptArgs: PromptArgs = args.promptMessageId
    ? args.prompt !== undefined
      ? {
          promptMessageId: args.promptMessageId,
          prompt: args.prompt as Array<ModelMessage>,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        }
      : { promptMessageId: args.promptMessageId, maxOutputTokens: MAX_OUTPUT_TOKENS }
    : { prompt: args.prompt!, maxOutputTokens: MAX_OUTPUT_TOKENS };

  return runInRunSpan(
    {
      userId,
      threadId,
      source,
      provider,
      environment,
      release,
      promptVersion,
      hasImages,
      isByok,
    },
    async (span) => {
      const runId = span.runId;
      const telemetry: TelemetryArgs = {
        runId,
        userId,
        threadId,
        provider,
        source,
        environment,
        release,
        promptVersion,
        hasImages,
        isByok,
      };

      const accInit: AccumulatorInit = {
        runId,
        userId: userId as Id<"users">,
        threadId,
        messageId: args.promptMessageId,
        source,
        environment,
        release,
        promptVersion,
        startedAt: Date.now(),
        scheduledAt,
        processingStartedAt,
        retrievalEnabled,
      };
      const accumulator = new RunAccumulator(accInit);

      const errorReport = { threadId, userId, isByok, provider };

      const runAttempt = async (agent: Agent): Promise<AttemptOutcome> => {
        try {
          await attemptStream({ ctx, agent, promptArgs, telemetry, accumulator });
          return { done: true, success: true };
        } catch (error) {
          if (await safeTryReportByok(ctx, { ...errorReport, error })) {
            const cls = classifyByokError(error) ?? "byok_unknown_error";
            accumulator.setTerminalErrorClass(cls);
            span.recordError(cls);
            return { done: true, success: false };
          }
          if (isQuotaError(error) || !isTransientError(error)) {
            const cls = errorClassName(error);
            accumulator.setTerminalErrorClass(cls);
            span.recordError(cls);
            await safeReportError(ctx, { ...errorReport, error });
            return { done: true, success: false };
          }
          return { done: false, error };
        }
      };

      await runWithPrimaryCircuitBreaker({
        ctx,
        primaryAgent,
        fallbackAgent,
        primaryModelName,
        provider,
        runId,
        threadId,
        userId,
        accumulator,
        retryDelayMs: RETRY_DELAY_MS,
        runAttempt,
        finalizePending: (reason) => safeFinalizePending(ctx, threadId, reason),
        recordTerminalError: async (error) => {
          const cls = errorClassName(error);
          accumulator.setTerminalErrorClass(cls);
          span.recordError(cls);
          await safeReportError(ctx, { ...errorReport, error });
        },
      });
      return accumulator;
    },
  );
}

function errorClassName(error: unknown): string {
  if (error instanceof Error) return error.name;
  return "Unknown";
}

interface TelemetryArgs {
  runId: string;
  userId: string;
  threadId: string;
  provider: ProviderId;
  source: "chat" | "approval_continuation";
  environment: "dev" | "prod";
  release?: string;
  promptVersion?: string;
  hasImages?: boolean;
  isByok: boolean;
}

interface AttemptStreamOptions {
  ctx: ActionCtx;
  agent: Agent;
  promptArgs: PromptArgs;
  telemetry: TelemetryArgs;
  accumulator: RunAccumulator;
}

async function attemptStream({
  ctx,
  agent,
  promptArgs,
  telemetry,
  accumulator,
}: AttemptStreamOptions): Promise<void> {
  const { threadId, userId } = telemetry;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Stream timeout"), ATTEMPT_TIMEOUT_MS);
  let budgetTrip: BudgetCapTrip | undefined;
  try {
    const { thread } = await agent.continueThread(ctx, { threadId, userId });
    const stopWhen = telemetry.isByok
      ? [
          stepCountIs(COACH_MAX_STEPS),
          budgetCapStopCondition(telemetry.provider, (trip) => {
            budgetTrip = trip;
          }),
        ]
      : stepCountIs(COACH_MAX_STEPS);
    const result = await thread.streamText(
      {
        ...promptArgs,
        abortSignal: controller.signal,
        stopWhen,
        experimental_telemetry: buildTelemetryConfig(telemetry),
        experimental_context: { runId: telemetry.runId },
        // @convex-dev/agent drops thought_signature from stored tool calls; disabling thinking prevents Gemini from requiring them on replay.
        providerOptions:
          telemetry.provider === "gemini"
            ? { google: { thinkingConfig: { thinkingBudget: 0 } } }
            : undefined,
        onChunk: (event: { chunk: { type: string } }) => {
          try {
            if (event.chunk.type === "text-delta") accumulator.markFirstChunk();
          } catch {
            // Telemetry must never fail the LLM turn.
          }
        },
        onStepFinish: (step: StepResult<ToolSet>) => {
          try {
            accumulator.onStepFinish(step);
          } catch {
            // Telemetry must never fail the LLM turn.
          }
        },
        onFinish: () => {
          try {
            accumulator.markFinished();
          } catch {
            // Telemetry must never fail the LLM turn.
          }
        },
        onError: async ({ error }: { error: unknown }) => {
          // @convex-dev/agent@0.6.1 does not catch stream error events in its
          // internal finalizeMessage mutation — the raw provider error propagates
          // as an unhandled exception that Convex reports to Sentry. Pre-empting
          // with a sanitized finalize code here prevents the agent library from
          // encountering the error-event delta when its mutation runs, because
          // a message that is already "failed" skips further delta processing.
          await safeFinalizePending(ctx, threadId, getFinalizeCodeForError(error));
        },
      },
      STREAM_OPTIONS,
    );
    // Await the full text. If the stream delivers an error event, @convex-dev/agent@0.6.1
    // may throw from its internal finalizeMessage mutation before our onError pre-emption
    // completes. Catching here ensures the pending message is always finalized and the
    // error reaches the circuit-breaker retry path with a clean thread state.
    try {
      await result.text;
    } catch (streamError) {
      await safeFinalizePending(ctx, threadId, getFinalizeCodeForError(streamError));
      throw streamError;
    }
    if (accumulator.toRow().finishReason === "error") throw new Error("provider_response_failed");
    if (budgetTrip) {
      await ctx.runMutation(internal.aiUsage.recordBudgetStop, {
        userId: userId as Id<"users">,
        threadId,
        provider: telemetry.provider,
        model: budgetTrip.modelId ?? "unknown",
      });
      await saveMessage(ctx, components.agent, {
        threadId,
        userId,
        message: { role: "assistant", content: BUDGET_CAP_MESSAGE },
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Raw inputs/outputs go to Phoenix Cloud for conversation capture. BYOK keys
// and Tonal tokens are sanitized upstream in byokErrors/chatHelpers so AI SDK
// messages never carry secrets by the time they reach this layer.
function buildTelemetryConfig(telemetry: TelemetryArgs): TelemetrySettings {
  const metadata: Record<string, string | boolean> = {
    runId: telemetry.runId,
    threadId: telemetry.threadId,
    userId: telemetry.userId,
    provider: telemetry.provider,
    source: telemetry.source,
    environment: telemetry.environment,
    isByok: telemetry.isByok,
  };
  if (telemetry.release) metadata.release = telemetry.release;
  if (telemetry.promptVersion) metadata.promptVersion = telemetry.promptVersion;
  if (typeof telemetry.hasImages === "boolean") metadata.hasImages = telemetry.hasImages;

  return {
    isEnabled: true,
    functionId: "coach-agent",
    recordInputs: true,
    recordOutputs: true,
    metadata,
  };
}
