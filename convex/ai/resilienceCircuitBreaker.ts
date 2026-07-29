import type { Agent } from "@convex-dev/agent";
import { makeFunctionReference } from "convex/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { estimateAttemptCostUsd } from "./circuitBreakerCore";
import type { ProviderId } from "./providers";
import { getFinalizeCodeForError, sanitizeErrorCode } from "./resilienceReporting";
import type { AttemptUsageSnapshot, RunAccumulator } from "./runTelemetry";

const reservePrimaryAttemptRef = makeFunctionReference<
  "mutation",
  { provider: ProviderId; runId: string; userId?: Id<"users">; threadId?: string },
  {
    route: "primary" | "fallback";
    reason: "closed" | "open_circuit" | "half_open_probe" | "half_open_busy";
  }
>("ai/circuitBreaker:reservePrimaryAttempt");

const recordPrimaryAttemptFailureRef = makeFunctionReference<
  "mutation",
  {
    provider: ProviderId;
    runId: string;
    userId?: Id<"users">;
    threadId?: string;
    model: string;
    totalCostUsd?: number;
    errorClass: string;
  },
  {
    opened: boolean;
    openReason: "error_threshold" | "cost_threshold" | "half_open_failure" | null;
    recentFailures: number;
    recentFailedCostUsd: number;
  }
>("ai/circuitBreaker:recordPrimaryAttemptFailure");

const recordPrimaryAttemptSuccessRef = makeFunctionReference<
  "mutation",
  {
    provider: ProviderId;
    runId: string;
    userId?: Id<"users">;
    threadId?: string;
    model: string;
  },
  { closed: boolean }
>("ai/circuitBreaker:recordPrimaryAttemptSuccess");

export type AttemptOutcome =
  | { done: true; success: true }
  | { done: true; success: false; errorClass: string }
  | { done: false; error: unknown };

type FallbackOutcome =
  | { status: "pending" }
  | { status: "succeeded" }
  | { status: "failed"; errorClass: string }
  | { status: "not_attempted"; reason: string };
type CompletedFallbackOutcome = Exclude<FallbackOutcome, { status: "pending" }>;

interface CircuitBreakerFlowArgs {
  ctx: ActionCtx;
  primaryAgent: Agent;
  fallbackAgent: Agent;
  primaryModelName: string;
  provider: ProviderId;
  runId: string;
  threadId: string;
  userId: string;
  accumulator: RunAccumulator;
  retryDelayMs: number;
  runAttempt: (agent: Agent) => Promise<AttemptOutcome>;
  finalizePending: (reason: string) => Promise<void>;
  markRetrying: () => Promise<void>;
  recordTerminalError: (error: unknown) => Promise<void>;
}

export async function runWithPrimaryCircuitBreaker(args: CircuitBreakerFlowArgs): Promise<void> {
  const {
    ctx,
    primaryAgent,
    fallbackAgent,
    primaryModelName,
    provider,
    runId,
    threadId,
    userId,
    accumulator,
    retryDelayMs,
    runAttempt,
    finalizePending,
    markRetrying,
    recordTerminalError,
  } = args;
  const breakerUserId = userId as Id<"users">;

  const scheduleNotification = async (notification: {
    source: string;
    message: string;
    userId?: string;
  }): Promise<void> => {
    try {
      await ctx.scheduler.runAfter(0, internal.discord.notifyError, notification);
    } catch {
      // Alerting is optional and must never cancel the user's retry or fallback.
    }
  };

  const notifyBreakerOpened = async (details: {
    openReason: "error_threshold" | "cost_threshold" | "half_open_failure";
    recentFailures: number;
    recentFailedCostUsd: number;
    primaryErrorClass: string;
    fallbackOutcome: FallbackOutcome;
  }) => {
    await scheduleNotification({
      source: "aiCircuitBreaker",
      message: [
        `Opened ${provider} circuit breaker (${details.openReason}) after ${details.recentFailures} failed primary attempts and $${details.recentFailedCostUsd.toFixed(2)} of failed spend in the last 60s`,
        `Primary error: ${details.primaryErrorClass}`,
        `Fallback: ${formatFallbackOutcome(details.fallbackOutcome)}`,
        `Run: ${runId}`,
        `Thread: ${threadId}`,
      ].join("\n"),
      userId,
    });
  };

  const notifyFallbackCompleted = async (details: {
    openReason: "error_threshold" | "cost_threshold" | "half_open_failure";
    fallbackOutcome: CompletedFallbackOutcome;
  }) => {
    await scheduleNotification({
      source: "aiCircuitBreaker",
      message: [
        `Fallback completed for ${provider} circuit breaker (${details.openReason})`,
        `Fallback: ${formatFallbackOutcome(details.fallbackOutcome)}`,
        `Run: ${runId}`,
        `Thread: ${threadId}`,
      ].join("\n"),
      userId,
    });
  };

  const recordPrimaryFailure = async (failure: {
    error: unknown;
    snapshot: AttemptUsageSnapshot;
  }) => {
    const usage = accumulator.usageDeltaSince(failure.snapshot);
    const model = usage.modelId ?? primaryModelName;
    const primaryErrorClass = errorClassName(failure.error);
    const totalCostUsd = estimateAttemptCostUsd({
      provider,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });
    const result: {
      opened: boolean;
      openReason: "error_threshold" | "cost_threshold" | "half_open_failure" | null;
      recentFailures: number;
      recentFailedCostUsd: number;
    } = await ctx.runMutation(recordPrimaryAttemptFailureRef, {
      provider,
      runId,
      userId: breakerUserId,
      threadId,
      model,
      totalCostUsd,
      errorClass: primaryErrorClass,
    });
    return { ...result, primaryErrorClass };
  };

  const runFallbackAttempt = async (): Promise<CompletedFallbackOutcome> => {
    const final = await runAttempt(fallbackAgent);
    if (!final.done) {
      await recordTerminalError(final.error);
      return { status: "failed", errorClass: errorClassName(final.error) };
    }
    if (final.success) return { status: "succeeded" };
    return { status: "failed", errorClass: sanitizeErrorCode(final.errorClass) };
  };

  const routeDecision: {
    route: "primary" | "fallback";
    reason: "closed" | "open_circuit" | "half_open_probe" | "half_open_busy";
  } = await ctx.runMutation(reservePrimaryAttemptRef, {
    provider,
    runId,
    userId: breakerUserId,
    threadId,
  });

  if (routeDecision.route === "fallback") {
    accumulator.markFallback("circuit_open");
    const final = await runAttempt(fallbackAgent);
    if (!final.done) {
      await recordTerminalError(final.error);
    }
    return;
  }

  const isHalfOpenProbe = routeDecision.reason === "half_open_probe";
  const firstAttemptSnapshot = accumulator.snapshotUsage();
  const firstAttempt = await runAttempt(primaryAgent);
  if (firstAttempt.done) {
    if (isHalfOpenProbe) {
      const finalUsage = accumulator.snapshotUsage();
      if (firstAttempt.success) {
        await ctx.runMutation(recordPrimaryAttemptSuccessRef, {
          provider,
          runId,
          userId: breakerUserId,
          threadId,
          model: finalUsage.modelId ?? primaryModelName,
        });
      } else {
        const terminalErrorClass = sanitizeErrorCode(firstAttempt.errorClass);
        const failure = await ctx.runMutation(recordPrimaryAttemptFailureRef, {
          provider,
          runId,
          userId: breakerUserId,
          threadId,
          model: finalUsage.modelId ?? primaryModelName,
          errorClass: terminalErrorClass,
        });
        if (failure.opened && failure.openReason) {
          await notifyBreakerOpened({
            openReason: failure.openReason,
            recentFailures: failure.recentFailures,
            recentFailedCostUsd: failure.recentFailedCostUsd,
            primaryErrorClass: terminalErrorClass,
            fallbackOutcome: {
              status: "not_attempted",
              reason: "terminal_primary_failure",
            },
          });
        }
      }
    }
    return;
  }

  const firstFailure = await recordPrimaryFailure({
    error: firstAttempt.error,
    snapshot: firstAttemptSnapshot,
  });
  if (firstFailure.opened) {
    await finalizePending("transient_retry");
    await markRetrying();
    accumulator.markFallback("circuit_open");
    const fallbackOutcome = await runFallbackAttempt();
    if (firstFailure.openReason) {
      await notifyBreakerOpened({
        openReason: firstFailure.openReason,
        recentFailures: firstFailure.recentFailures,
        recentFailedCostUsd: firstFailure.recentFailedCostUsd,
        primaryErrorClass: firstFailure.primaryErrorClass,
        fallbackOutcome,
      });
    }
    return;
  }

  await finalizePending("transient_retry");
  await markRetrying();
  accumulator.markRetry();
  await delay(retryDelayMs);

  const secondAttemptSnapshot = accumulator.snapshotUsage();
  const secondAttempt = await runAttempt(primaryAgent);
  if (secondAttempt.done) return;

  const secondFailure = await recordPrimaryFailure({
    error: secondAttempt.error,
    snapshot: secondAttemptSnapshot,
  });
  await finalizePending("transient_retry");
  await markRetrying();
  accumulator.markRetry();
  accumulator.markFallback(secondFailure.opened ? "circuit_open" : "transient_exhaustion");

  if (secondFailure.opened && secondFailure.openReason) {
    await notifyBreakerOpened({
      openReason: secondFailure.openReason,
      recentFailures: secondFailure.recentFailures,
      recentFailedCostUsd: secondFailure.recentFailedCostUsd,
      primaryErrorClass: secondFailure.primaryErrorClass,
      fallbackOutcome: { status: "pending" },
    });
  }
  const fallbackOutcome = await runFallbackAttempt();
  if (secondFailure.opened && secondFailure.openReason) {
    await notifyFallbackCompleted({
      openReason: secondFailure.openReason,
      fallbackOutcome,
    });
  }
}

function formatFallbackOutcome(outcome: FallbackOutcome): string {
  if (outcome.status === "pending") return "pending";
  if (outcome.status === "succeeded") return "succeeded";
  if (outcome.status === "failed") return `failed (${outcome.errorClass})`;
  return `not attempted (${outcome.reason})`;
}

function errorClassName(error: unknown): string {
  return getFinalizeCodeForError(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
