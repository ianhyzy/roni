"use node";

import type { Agent, MessageDoc } from "@convex-dev/agent";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { saveMessage } from "@convex-dev/agent";
import { stepCountIs } from "ai";
import type { PrepareStepFunction, StepResult, ToolSet } from "ai";
import { components, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { budgetCapStopCondition, type BudgetCapTrip } from "./budgetCap";
import {
  type AiBudgetPolicy,
  DEFAULT_PROVIDER_BUDGET_LIMITS_USD,
} from "../../lib/aiBudgetPreferences";
import { COACH_MAX_STEPS } from "./coach";
import { type ProviderId } from "./providers";
import { type AttemptOutcome, runWithPrimaryCircuitBreaker } from "./resilienceCircuitBreaker";
import { type AccumulatorInit, RunAccumulator } from "./runTelemetry";
import { classifyByokError, consumeCapturedError, resetCapturedError } from "./byokErrors";
import { buildCoachTelemetryConfig, runInRunSpan } from "./otel";
import { isQuotaError, isTransientError } from "./transientErrors";
import {
  type AgentTurnRef,
  clearTurnRetrying,
  getFinalizeCodeForError,
  markTurnRetrying,
  RETRYING_MESSAGE_ERROR,
  safeFinalizePending,
  safeMarkFailedTurnMessagesAsSuperseded,
  safeReportError,
  safeTryReportByok,
} from "./resilienceReporting";

export { getFinalizeCodeForError } from "./resilienceReporting";
const BUDGET_CAP_MESSAGE =
  "This model attempt reached your personal API budget limit, so I'm stopping here. A narrower follow-up starts a new attempt with a new limit.";
const MASKED_UI_STREAM_ERROR = "An error occurred.";
const MAX_OUTPUT_TOKENS = 4096;
const RETRY_DELAY_MS = 3000;

interface StreamWithRetryArgs {
  primaryAgent: Agent;
  fallbackAgent: Agent;
  primaryModelName: string;
  prepareStep?: PrepareStepFunction<ToolSet>;
  fallbackPrepareStep?: PrepareStepFunction<ToolSet>;
  threadId: string;
  userId: string;
  prompt?: string | Array<ModelMessage>;
  promptMessageId: string;
  isByok: boolean;
  budgetPolicy?: AiBudgetPolicy;
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
    prepareStep,
    fallbackPrepareStep,
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
  const turnRef: AgentTurnRef = { threadId, promptMessageId: args.promptMessageId };
  const promptArgs: PromptArgs =
    args.prompt !== undefined
      ? {
          promptMessageId: args.promptMessageId,
          prompt: args.prompt as Array<ModelMessage>,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        }
      : { promptMessageId: args.promptMessageId, maxOutputTokens: MAX_OUTPUT_TOKENS };

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
        budgetPolicy: args.budgetPolicy,
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

      const errorReport = { ...turnRef, userId, isByok, provider };
      let hasRetryMarker = false;
      await markTurnRetrying(ctx, turnRef);
      hasRetryMarker = true;
      const finalizeTurnPending = (reason: string) => safeFinalizePending(ctx, turnRef, reason);

      const runAttempt = async (agent: Agent): Promise<AttemptOutcome> => {
        resetCapturedError(agent);
        const attemptPrepareStep =
          agent === fallbackAgent ? (fallbackPrepareStep ?? prepareStep) : prepareStep;
        try {
          await attemptStream({
            ctx,
            agent,
            promptArgs,
            turnRef,
            prepareStep: attemptPrepareStep,
            telemetry,
            accumulator,
          });
          return { done: true, success: true };
        } catch (error) {
          if (await safeTryReportByok(ctx, { ...errorReport, error })) {
            const cls = classifyByokError(error) ?? "byok_unknown_error";
            accumulator.setTerminalErrorClass(cls);
            span.recordError(cls);
            return { done: true, success: false, errorClass: cls };
          }
          if (isQuotaError(error) || !isTransientError(error)) {
            const cls = getFinalizeCodeForError(error);
            accumulator.setTerminalErrorClass(cls);
            span.recordError(cls);
            await safeReportError(ctx, { ...errorReport, error });
            return { done: true, success: false, errorClass: cls };
          }
          await finalizeTurnPending(RETRYING_MESSAGE_ERROR);
          await safeMarkFailedTurnMessagesAsSuperseded(ctx, turnRef);
          await markTurnRetrying(ctx, turnRef);
          hasRetryMarker = true;
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
        finalizePending: finalizeTurnPending,
        markRetrying: async () => {
          await markTurnRetrying(ctx, turnRef);
          hasRetryMarker = true;
        },
        recordTerminalError: async (error) => {
          const cls = getFinalizeCodeForError(error);
          accumulator.setTerminalErrorClass(cls);
          span.recordError(cls);
          await safeReportError(ctx, { ...errorReport, error });
        },
      });
      if (hasRetryMarker) await clearTurnRetrying(ctx, turnRef);
      return accumulator;
    },
  );
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
  budgetPolicy?: AiBudgetPolicy;
}

interface AttemptStreamOptions {
  ctx: ActionCtx;
  agent: Agent;
  promptArgs: PromptArgs;
  turnRef: AgentTurnRef;
  prepareStep?: PrepareStepFunction<ToolSet>;
  telemetry: TelemetryArgs;
  accumulator: RunAccumulator;
}

async function attemptStream({
  ctx,
  agent,
  promptArgs,
  turnRef,
  prepareStep,
  telemetry,
  accumulator,
}: AttemptStreamOptions): Promise<void> {
  const { threadId, userId } = telemetry;
  const finalizeTurnPending = (reason: string) => safeFinalizePending(ctx, turnRef, reason);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Stream timeout"), ATTEMPT_TIMEOUT_MS);
  let budgetTrip: BudgetCapTrip | undefined;
  let reportedProviderError: unknown;
  const reportedOrCapturedError = (fallback: unknown): unknown =>
    reportedProviderError instanceof Error &&
    reportedProviderError.message === MASKED_UI_STREAM_ERROR
      ? (consumeCapturedError(agent) ?? reportedProviderError ?? fallback)
      : (reportedProviderError ?? consumeCapturedError(agent) ?? fallback);
  const preferReportedProviderError = (error: unknown): unknown =>
    error instanceof Error && error.message === MASKED_UI_STREAM_ERROR
      ? reportedOrCapturedError(error)
      : error;
  try {
    const { thread } = await agent.continueThread(ctx, { threadId, userId });
    const budgetPolicy =
      telemetry.budgetPolicy ??
      (telemetry.isByok
        ? {
            kind: "limit" as const,
            maxAttemptUsd: DEFAULT_PROVIDER_BUDGET_LIMITS_USD[telemetry.provider],
          }
        : { kind: "disabled" as const });
    const stopWhen =
      budgetPolicy.kind === "limit"
        ? [
            stepCountIs(COACH_MAX_STEPS),
            budgetCapStopCondition({
              provider: telemetry.provider,
              maxAttemptUsd: budgetPolicy.maxAttemptUsd,
              onTrip: (trip) => {
                budgetTrip = trip;
              },
            }),
          ]
        : stepCountIs(COACH_MAX_STEPS);
    const streamPromise = thread.streamText(
      {
        ...promptArgs,
        abortSignal: controller.signal,
        stopWhen,
        prepareStep,
        experimental_telemetry: buildCoachTelemetryConfig(telemetry),
        experimental_context: { runId: telemetry.runId },
        // @ai-sdk/google restores missing thought signatures on replay; minimal thinking keeps Gemini 3 coach turns responsive.
        providerOptions:
          telemetry.provider === "gemini"
            ? { google: { thinkingConfig: { thinkingLevel: "minimal" } } }
            : undefined,
        onChunk: (event: { chunk: { type: string } }) => {
          try {
            if (event.chunk.type === "text-delta") accumulator.markFirstChunk();
          } catch {
            // Telemetry must never fail the LLM turn.
          }
        },
        onStepFinish: async (step: StepResult<ToolSet>) => {
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
          reportedProviderError ??= error;
          // Pre-empt the agent library's unhandled error-event delta with a safe code.
          await finalizeTurnPending(getAttemptFinalizeCode(error, telemetry.isByok));
        },
      },
      STREAM_OPTIONS,
    );
    const result = await streamPromise.catch(async (streamError: unknown) => {
      const error = preferReportedProviderError(streamError);
      await finalizeTurnPending(getAttemptFinalizeCode(error, telemetry.isByok));
      throw error;
    });
    await failSavedProviderErrorMessages(ctx, result.savedMessages ?? []);
    // Await the full text so every error reaches the retry path with a clean thread state.
    try {
      await result.text;
    } catch (streamError) {
      const error = preferReportedProviderError(streamError);
      await finalizeTurnPending(getAttemptFinalizeCode(error, telemetry.isByok));
      throw error;
    }
    if (accumulator.toRow().finishReason === "error") {
      throw reportedOrCapturedError(new Error("provider_response_failed"));
    }
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

async function failSavedProviderErrorMessages(
  ctx: ActionCtx,
  savedMessages: readonly MessageDoc[],
): Promise<void> {
  for (const message of savedMessages) {
    if (message.finishReason !== "error" || message.status === "failed") continue;
    await ctx.runMutation(components.agent.messages.updateMessage, {
      messageId: message._id,
      patch: { status: "failed", error: RETRYING_MESSAGE_ERROR },
    });
  }
}

function getAttemptFinalizeCode(error: unknown, isByok: boolean): string {
  const isRetryable =
    !isQuotaError(error) &&
    isTransientError(error) &&
    (!isByok || classifyByokError(error) === null);
  return isRetryable ? RETRYING_MESSAGE_ERROR : getFinalizeCodeForError(error);
}
