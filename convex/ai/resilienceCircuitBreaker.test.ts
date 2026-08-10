import type { Agent } from "@convex-dev/agent";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { runWithPrimaryCircuitBreaker } from "./resilienceCircuitBreaker";
import type { RunAccumulator } from "./runTelemetry";

describe("runWithPrimaryCircuitBreaker", () => {
  it("continues the fallback when durable alert scheduling fails", async () => {
    let mutationCalls = 0;
    const runMutation = vi.fn(async (_ref: unknown, _args: Record<string, unknown>) => {
      mutationCalls += 1;
      if (mutationCalls === 1) {
        return {
          route: "primary",
          reason: "half_open_probe",
        };
      }
      return {
        opened: true,
        openReason: "half_open_failure",
        recentFailures: 1,
        recentFailedCostUsd: 0,
      };
    });
    const runAfter = vi.fn(
      async (
        _delayMs: number,
        _ref: unknown,
        _args: { source: string; message: string; userId?: string },
      ): Promise<void> => {
        throw new Error("scheduler unavailable");
      },
    );
    const ctx = {
      runMutation,
      scheduler: { runAfter },
    } as unknown as ActionCtx;
    const accumulator = {
      snapshotUsage: vi.fn(() => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
        modelId: undefined,
      })),
      usageDeltaSince: vi.fn(() => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.75,
        modelId: "claude-sonnet-4-5",
      })),
      markFallback: vi.fn(),
    } as unknown as RunAccumulator;
    const primaryAgent = {} as Agent;
    const fallbackAgent = {} as Agent;
    const runAttempt = vi
      .fn()
      .mockResolvedValueOnce({ done: false, error: new Error("overloaded") } as const)
      .mockResolvedValueOnce({ done: true, success: true } as const);
    const finalizePending = vi.fn(async () => undefined);
    const markRetrying = vi.fn(async () => undefined);
    const recordTerminalError = vi.fn(async () => undefined);

    await runWithPrimaryCircuitBreaker({
      ctx,
      primaryAgent,
      fallbackAgent,
      primaryModelName: "claude-sonnet-4-5",
      provider: "claude",
      runId: "run-1",
      threadId: "thread-1",
      userId: "user-1",
      accumulator,
      retryDelayMs: 1,
      runAttempt,
      finalizePending,
      markRetrying,
      recordTerminalError,
    });

    expect(runAttempt).toHaveBeenNthCalledWith(1, primaryAgent);
    expect(runAttempt).toHaveBeenNthCalledWith(2, fallbackAgent);
    expect(accumulator.markFallback).toHaveBeenCalledWith("circuit_open");
    expect(markRetrying).toHaveBeenCalledTimes(1);
    expect(markRetrying.mock.invocationCallOrder[0]).toBeLessThan(
      runAttempt.mock.invocationCallOrder[1] ?? 0,
    );
    expect(recordTerminalError).not.toHaveBeenCalled();
    expect(runMutation.mock.calls[1]?.[1]).toMatchObject({ totalCostUsd: 0.75 });
    const notifyArgs = runAfter.mock.calls[0]?.[2];
    expect(notifyArgs).toMatchObject({
      source: "aiCircuitBreaker",
      message: expect.stringContaining("Fallback: succeeded"),
      userId: "user-1",
    });
  });

  it("waits for the durable retry marker before the backoff and second attempt", async () => {
    let mutationCalls = 0;
    const runMutation = vi.fn(async () => {
      mutationCalls += 1;
      if (mutationCalls === 1) return { route: "primary", reason: "closed" };
      return {
        opened: false,
        openReason: null,
        recentFailures: 1,
        recentFailedCostUsd: 0,
      };
    });
    const ctx = {
      runMutation,
      scheduler: { runAfter: vi.fn(async () => undefined) },
    } as unknown as ActionCtx;
    const accumulator = {
      snapshotUsage: vi.fn(() => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
        modelId: "gemini-2.5-flash",
      })),
      usageDeltaSince: vi.fn(() => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
        modelId: "gemini-2.5-flash",
      })),
      markRetry: vi.fn(),
    } as unknown as RunAccumulator;
    const runAttempt = vi
      .fn()
      .mockResolvedValueOnce({ done: false, error: new Error("overloaded") } as const)
      .mockResolvedValueOnce({ done: true, success: true } as const);
    let releaseMarker: () => void = () => undefined;
    const markerPersisted = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    const markRetrying = vi.fn(() => markerPersisted);

    const flow = runWithPrimaryCircuitBreaker({
      ctx,
      primaryAgent: {} as Agent,
      fallbackAgent: {} as Agent,
      primaryModelName: "gemini-2.5-flash",
      provider: "gemini",
      runId: "run-marker-order",
      threadId: "thread-1",
      userId: "user-1",
      accumulator,
      retryDelayMs: 0,
      runAttempt,
      finalizePending: vi.fn(async () => undefined),
      markRetrying,
      recordTerminalError: vi.fn(async () => undefined),
    });

    await vi.waitFor(() => expect(markRetrying).toHaveBeenCalledTimes(1));
    expect(runAttempt).toHaveBeenCalledTimes(1);

    releaseMarker();
    await flow;

    expect(runAttempt).toHaveBeenCalledTimes(2);
  });

  it("notifies before the final fallback when a second primary failure opens the breaker", async () => {
    let mutationCalls = 0;
    const runMutation = vi.fn(async (_ref: unknown, _args: Record<string, unknown>) => {
      mutationCalls += 1;
      if (mutationCalls === 1) {
        return {
          route: "primary",
          reason: "closed",
        };
      }
      if (mutationCalls === 2) {
        return {
          opened: false,
          openReason: null,
          recentFailures: 1,
          recentFailedCostUsd: 0,
        };
      }
      return {
        opened: true,
        openReason: "cost_threshold",
        recentFailures: 2,
        recentFailedCostUsd: 1.25,
      };
    });
    const runAfter = vi.fn(
      async (
        _delayMs: number,
        _ref: unknown,
        _args: { source: string; message: string; userId?: string },
      ): Promise<void> => undefined,
    );
    const ctx = {
      runMutation,
      scheduler: { runAfter },
    } as unknown as ActionCtx;
    const accumulator = {
      snapshotUsage: vi.fn(() => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
        modelId: undefined,
      })),
      usageDeltaSince: vi.fn(() => ({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.625,
        modelId: "claude-sonnet-4-5",
      })),
      markRetry: vi.fn(),
      markFallback: vi.fn(),
    } as unknown as RunAccumulator;
    const runAttempt = vi
      .fn()
      .mockResolvedValueOnce({ done: false, error: new Error("first failure") } as const)
      .mockResolvedValueOnce({ done: false, error: new Error("second failure") } as const)
      .mockResolvedValueOnce({ done: true, success: true } as const);
    const markRetrying = vi.fn(async () => undefined);

    await runWithPrimaryCircuitBreaker({
      ctx,
      primaryAgent: {} as Agent,
      fallbackAgent: {} as Agent,
      primaryModelName: "claude-sonnet-4-5",
      provider: "claude",
      runId: "run-2",
      threadId: "thread-2",
      userId: "user-2",
      accumulator,
      retryDelayMs: 1,
      runAttempt,
      finalizePending: vi.fn(async () => undefined),
      markRetrying,
      recordTerminalError: vi.fn(async () => undefined),
    });

    expect(runAttempt).toHaveBeenCalledTimes(3);
    expect(markRetrying).toHaveBeenCalledTimes(2);
    expect(markRetrying.mock.invocationCallOrder[1]).toBeLessThan(
      runAfter.mock.invocationCallOrder[0] ?? 0,
    );
    expect(runAfter).toHaveBeenCalledTimes(2);
    expect(runAfter.mock.invocationCallOrder[0]).toBeLessThan(
      runAttempt.mock.invocationCallOrder[2] ?? 0,
    );
    expect(runAfter.mock.calls[0]?.[2]).toMatchObject({
      source: "aiCircuitBreaker",
      message: expect.stringContaining("Fallback: pending"),
      userId: "user-2",
    });
    expect(runAfter.mock.calls[1]?.[2]).toMatchObject({
      source: "aiCircuitBreaker",
      message: expect.stringContaining("Fallback: succeeded"),
      userId: "user-2",
    });
  });

  it("records a terminal half-open probe failure before returning", async () => {
    let mutationCalls = 0;
    const runMutation = vi.fn(async (_ref: unknown, _args: Record<string, unknown>) => {
      mutationCalls += 1;
      if (mutationCalls === 1) {
        return {
          route: "primary",
          reason: "half_open_probe",
        };
      }
      return {
        opened: true,
        openReason: "half_open_failure",
        recentFailures: 1,
        recentFailedCostUsd: 0,
      };
    });
    const runAfter = vi.fn(
      async (
        _delayMs: number,
        _ref: unknown,
        _args: { source: string; message: string; userId?: string },
      ): Promise<void> => undefined,
    );
    const ctx = {
      runMutation,
      scheduler: { runAfter },
    } as unknown as ActionCtx;
    const firstAttemptSnapshot = {
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.25,
      modelId: "gemini-2.5-flash",
      provider: "google.generative-ai",
    };
    const accumulator = {
      snapshotUsage: vi.fn(() => firstAttemptSnapshot),
      usageDeltaSince: vi.fn(() => ({
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.001,
        modelId: "gemini-2.5-flash",
        provider: "google.generative-ai",
      })),
    } as unknown as RunAccumulator;
    const runAttempt = vi.fn(
      async () =>
        ({
          done: true,
          success: false,
          errorClass: "ProviderQuotaError",
        }) as const,
    );
    const finalizePending = vi.fn(async () => undefined);
    const markRetrying = vi.fn(async () => undefined);
    const recordTerminalError = vi.fn(async () => undefined);

    await runWithPrimaryCircuitBreaker({
      ctx,
      primaryAgent: {} as Agent,
      fallbackAgent: {} as Agent,
      primaryModelName: "gemini-2.5-flash",
      provider: "gemini",
      runId: "run-1",
      threadId: "thread-1",
      userId: "user-1",
      accumulator,
      retryDelayMs: 1,
      runAttempt,
      finalizePending,
      markRetrying,
      recordTerminalError,
    });

    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(runMutation).toHaveBeenCalledTimes(2);
    expect(runMutation.mock.calls[1]?.[1]).toMatchObject({
      provider: "gemini",
      runId: "run-1",
      userId: "user-1" as Id<"users">,
      threadId: "thread-1",
      model: "gemini-2.5-flash",
      totalCostUsd: 0.001,
      errorClass: "unexpected_error",
    });
    expect(accumulator.usageDeltaSince).toHaveBeenCalledWith(firstAttemptSnapshot);
    expect(runAfter).toHaveBeenCalledTimes(1);
    expect(runAfter.mock.calls[0]?.[2]).toMatchObject({
      source: "aiCircuitBreaker",
      message: expect.stringContaining("Primary error: unexpected_error"),
      userId: "user-1",
    });
    expect(runAfter.mock.calls[0]?.[2].message).toContain(
      "Fallback: not attempted (terminal_primary_failure)",
    );
    expect(finalizePending).not.toHaveBeenCalled();
    expect(markRetrying).not.toHaveBeenCalled();
    expect(recordTerminalError).not.toHaveBeenCalled();
  });
});
