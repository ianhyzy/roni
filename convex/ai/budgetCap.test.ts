import { describe, expect, it, vi } from "vitest";
import { budgetCapStopCondition, estimateAttemptCostUsd } from "./budgetCap";

describe("budgetCapStopCondition", () => {
  it("estimates one model attempt's cost from each step model id", () => {
    const cost = estimateAttemptCostUsd(
      [
        {
          usage: {
            inputTokens: 10_000,
            outputTokens: 2_000,
            totalTokens: 12_000,
            inputTokenDetails: {
              noCacheTokens: undefined,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokenDetails: {
              textTokens: undefined,
              reasoningTokens: undefined,
            },
          },
          model: { provider: "openai", modelId: "gpt-5.4-nano" },
        },
        {
          usage: {
            inputTokens: 5_000,
            outputTokens: 3_000,
            totalTokens: 8_000,
            inputTokenDetails: {
              noCacheTokens: undefined,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokenDetails: {
              textTokens: undefined,
              reasoningTokens: undefined,
            },
          },
          model: { provider: "openai", modelId: "gpt-5.4" },
        },
      ] as Parameters<typeof estimateAttemptCostUsd>[0],
      "openai",
    );

    expect(cost).toBeCloseTo(0.062, 6);
  });

  it("uses conservative provider pricing when a step omits model metadata", () => {
    const cost = estimateAttemptCostUsd(
      [
        {
          usage: {
            inputTokens: 10_000,
            outputTokens: 2_000,
            totalTokens: 12_000,
            inputTokenDetails: {
              noCacheTokens: undefined,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokenDetails: {
              textTokens: undefined,
              reasoningTokens: undefined,
            },
          },
        },
      ] as Parameters<typeof estimateAttemptCostUsd>[0],
      "openai",
    );

    expect(cost).toBeCloseTo(0.11, 6);
  });

  it("stops after a completed step crosses the cumulative-cost threshold", () => {
    let trip:
      | {
          estimatedCostUsd: number;
          modelId?: string;
          stepCount: number;
        }
      | undefined;
    const stopWhen = budgetCapStopCondition({
      provider: "openai",
      onTrip: (value) => {
        trip = value;
      },
    });

    const firstStop = stopWhen({
      steps: [
        {
          usage: { inputTokens: 10_000, outputTokens: 2_000 },
          model: { provider: "openai", modelId: "gpt-5.4" },
          finishReason: "tool-calls",
          toolCalls: [],
          toolResults: [],
          stepNumber: 0,
        } as unknown as Parameters<typeof stopWhen>[0]["steps"][number],
      ],
    });
    const secondStop = stopWhen({
      steps: [
        {
          usage: { inputTokens: 10_000, outputTokens: 2_000 },
          model: { provider: "openai", modelId: "gpt-5.4" },
          finishReason: "tool-calls",
          toolCalls: [],
          toolResults: [],
          stepNumber: 0,
        } as unknown as Parameters<typeof stopWhen>[0]["steps"][number],
        {
          usage: { inputTokens: 5_000, outputTokens: 3_000 },
          model: { provider: "openai", modelId: "gpt-5.4" },
          finishReason: "tool-calls",
          toolCalls: [],
          toolResults: [],
          stepNumber: 1,
        } as unknown as Parameters<typeof stopWhen>[0]["steps"][number],
      ],
    });

    expect(firstStop).toBe(false);
    expect(secondStop).toBe(true);
    expect(trip).toMatchObject({
      modelId: "gpt-5.4",
      stepCount: 2,
    });
    expect(trip?.estimatedCostUsd).toBeCloseTo(0.1125, 6);
    expect(trip?.estimatedCostUsd).toBeGreaterThan(0.1);
  });

  it("uses the configured provider budget threshold", () => {
    const onTrip = vi.fn();
    const stopWhen = budgetCapStopCondition({
      provider: "openai",
      maxAttemptUsd: 0.05,
      onTrip,
    });

    const shouldStop = stopWhen({
      steps: [
        {
          usage: { inputTokens: 10_000, outputTokens: 2_000 },
          model: { provider: "openai", modelId: "gpt-5.4" },
        } as unknown as Parameters<typeof stopWhen>[0]["steps"][number],
      ],
    });

    expect(shouldStop).toBe(true);
    expect(onTrip).toHaveBeenCalledOnce();
  });

  it("allows cost above the default when the configured limit is higher", () => {
    const onTrip = vi.fn();
    const stopWhen = budgetCapStopCondition({
      provider: "openai",
      maxAttemptUsd: 0.2,
      onTrip,
    });

    const shouldStop = stopWhen({
      steps: [
        {
          usage: { inputTokens: 10_000, outputTokens: 2_000 },
          model: { provider: "openai", modelId: "gpt-5.4" },
        },
        {
          usage: { inputTokens: 5_000, outputTokens: 3_000 },
          model: { provider: "openai", modelId: "gpt-5.4" },
        },
      ] as Parameters<typeof stopWhen>[0]["steps"],
    });

    expect(shouldStop).toBe(false);
    expect(onTrip).not.toHaveBeenCalled();
  });
});
