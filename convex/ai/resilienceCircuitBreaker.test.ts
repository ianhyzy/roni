import type { Agent } from "@convex-dev/agent";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { runWithPrimaryCircuitBreaker } from "./resilienceCircuitBreaker";
import type { RunAccumulator } from "./runTelemetry";

describe("runWithPrimaryCircuitBreaker", () => {
  it("reports fallback success after a transient half-open probe failure", async () => {
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
    const runAction = vi.fn(
      async (
        _ref: unknown,
        _args: { source: string; message: string; userId?: string },
      ): Promise<void> => undefined,
    );
    const ctx = {
      runMutation,
      runAction,
    } as unknown as ActionCtx;
    const accumulator = {
      snapshotUsage: vi.fn(() => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        modelId: undefined,
      })),
      usageDeltaSince: vi.fn(() => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
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
      recordTerminalError,
    });

    expect(runAttempt).toHaveBeenNthCalledWith(1, primaryAgent);
    expect(runAttempt).toHaveBeenNthCalledWith(2, fallbackAgent);
    expect(accumulator.markFallback).toHaveBeenCalledWith("circuit_open");
    expect(recordTerminalError).not.toHaveBeenCalled();
    const notifyArgs = runAction.mock.calls[0]?.[1];
    expect(notifyArgs).toMatchObject({
      source: "aiCircuitBreaker",
      message: expect.stringContaining("Fallback: succeeded"),
      userId: "user-1",
    });
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
    const runAction = vi.fn(
      async (
        _ref: unknown,
        _args: { source: string; message: string; userId?: string },
      ): Promise<void> => undefined,
    );
    const ctx = {
      runMutation,
      runAction,
    } as unknown as ActionCtx;
    const accumulator = {
      snapshotUsage: vi.fn(() => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        modelId: undefined,
      })),
      usageDeltaSince: vi.fn(() => ({
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
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
      recordTerminalError: vi.fn(async () => undefined),
    });

    expect(runAttempt).toHaveBeenCalledTimes(3);
    expect(runAction).toHaveBeenCalledTimes(2);
    expect(runAction.mock.invocationCallOrder[0]).toBeLessThan(
      runAttempt.mock.invocationCallOrder[2] ?? 0,
    );
    expect(runAction.mock.calls[0]?.[1]).toMatchObject({
      source: "aiCircuitBreaker",
      message: expect.stringContaining("Fallback: pending"),
      userId: "user-2",
    });
    expect(runAction.mock.calls[1]?.[1]).toMatchObject({
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
    const runAction = vi.fn(
      async (
        _ref: unknown,
        _args: { source: string; message: string; userId?: string },
      ): Promise<void> => undefined,
    );
    const ctx = {
      runMutation,
      runAction,
    } as unknown as ActionCtx;
    const accumulator = {
      snapshotUsage: vi.fn(() => ({
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        modelId: "gemini-2.5-flash",
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
      errorClass: "ProviderQuotaError",
    });
    expect(runAction).toHaveBeenCalledTimes(1);
    expect(runAction.mock.calls[0]?.[1]).toMatchObject({
      source: "aiCircuitBreaker",
      message: expect.stringContaining("Primary error: ProviderQuotaError"),
      userId: "user-1",
    });
    expect(runAction.mock.calls[0]?.[1].message).toContain(
      "Fallback: not attempted (terminal_primary_failure)",
    );
    expect(finalizePending).not.toHaveBeenCalled();
    expect(recordTerminalError).not.toHaveBeenCalled();
  });
});
