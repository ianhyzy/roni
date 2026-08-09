import { describe, expect, it, vi } from "vitest";
import { budgetCapStopCondition, estimateAttemptCostUsd } from "./budgetCap";
import { createModelStep } from "./modelStepTestUtils";

describe("budgetCapStopCondition", () => {
  it("estimates one model attempt's cost from each step model id", () => {
    const cost = estimateAttemptCostUsd(
      [
        createModelStep({
          inputTokens: 10_000,
          outputTokens: 2_000,
          modelId: "gpt-5.4-nano",
        }),
        createModelStep({ inputTokens: 5_000, outputTokens: 3_000 }),
      ],
      "openai",
    );

    expect(cost).toBeCloseTo(0.062, 6);
  });

  it("uses conservative provider pricing when a step omits model metadata", () => {
    const stepWithoutModelMetadata: Parameters<typeof estimateAttemptCostUsd>[0][number] = {
      usage: createModelStep({ inputTokens: 10_000, outputTokens: 2_000 }).usage,
    };

    const cost = estimateAttemptCostUsd([stepWithoutModelMetadata], "openai");

    expect(cost).toBeCloseTo(0.11, 6);
  });

  it("uses conservative provider pricing for a model from the wrong provider", () => {
    const cost = estimateAttemptCostUsd(
      [
        createModelStep({
          inputTokens: 10_000,
          outputTokens: 2_000,
          provider: "gemini",
          modelId: "openai/gpt-5.4-nano",
        }),
      ],
      "gemini",
    );

    expect(cost).toBeCloseTo(0.03, 6);
  });

  it("prices the response model when routing changes the requested model", () => {
    const cost = estimateAttemptCostUsd(
      [
        createModelStep({
          inputTokens: 300_000,
          outputTokens: 10_000,
          modelId: "gpt-5.4-mini",
          responseModelId: "gpt-5.6-sol",
          billingClass: "cache_write",
        }),
      ],
      "openai",
    );

    expect(cost).toBeCloseTo(4.2, 6);
  });

  it.each(["openrouter/auto", "attacker/unknown-model"])(
    "keeps OpenRouter request %s conservative when the response model is cheaper",
    (modelId) => {
      const cost = estimateAttemptCostUsd(
        [
          createModelStep({
            inputTokens: 300_000,
            outputTokens: 10_000,
            provider: "openai.chat",
            modelId,
            responseModelId: "google/gemini-2.5-flash",
            billingClass: "cache_write",
          }),
        ],
        "openrouter",
      );

      expect(cost).toBeCloseTo(4.2, 6);
    },
  );

  it("prices a trusted response model instead of a more expensive requested model", () => {
    const cost = estimateAttemptCostUsd(
      [
        createModelStep({
          inputTokens: 300_000,
          outputTokens: 10_000,
          modelId: "gpt-5.6-sol",
          responseModelId: "gpt-5.6-luna",
          billingClass: "cache_write",
        }),
      ],
      "openai",
    );

    expect(cost).toBeCloseTo(0.168, 6);
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
      maxAttemptUsd: 0.1,
      onTrip: (value) => {
        trip = value;
      },
    });

    const firstStep = createModelStep({ inputTokens: 10_000, outputTokens: 2_000 });
    const secondStep = createModelStep({
      inputTokens: 5_000,
      outputTokens: 3_000,
      stepNumber: 1,
    });

    const firstStop = stopWhen({ steps: [firstStep] });
    const secondStop = stopWhen({ steps: [firstStep, secondStep] });

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
      steps: [createModelStep({ inputTokens: 10_000, outputTokens: 2_000 })],
    });

    expect(shouldStop).toBe(true);
    expect(onTrip).toHaveBeenCalledOnce();
  });

  it("does not fire while cost stays under the configured limit", () => {
    const onTrip = vi.fn();
    const stopWhen = budgetCapStopCondition({
      provider: "openai",
      maxAttemptUsd: 0.2,
      onTrip,
    });

    const shouldStop = stopWhen({
      steps: [
        createModelStep({ inputTokens: 10_000, outputTokens: 2_000 }),
        createModelStep({ inputTokens: 5_000, outputTokens: 3_000, stepNumber: 1 }),
      ],
    });

    expect(shouldStop).toBe(false);
    expect(onTrip).not.toHaveBeenCalled();
  });

  it.each([
    ["uncached", 5, 10],
    ["cache_read", 0.5, 1],
    ["cache_write", 6.25, 12.5],
  ] as const)(
    "applies GPT-5.6 long-context %s pricing only above 272,000 input tokens",
    (billingClass, baseInputRate, longInputRate) => {
      const thresholdInputTokens = 272_000;
      const longInputTokens = thresholdInputTokens + 1;
      const outputTokens = 1_000;
      const atThreshold = createModelStep({
        inputTokens: thresholdInputTokens,
        outputTokens,
        modelId: "gpt-5.6-sol",
        billingClass,
      });
      const aboveThreshold = createModelStep({
        inputTokens: longInputTokens,
        outputTokens,
        modelId: "gpt-5.6-sol",
        billingClass,
      });

      const baseCost = estimateAttemptCostUsd([atThreshold], "openai");
      const longCost = estimateAttemptCostUsd([aboveThreshold], "openai");

      expect(baseCost).toBeCloseTo(
        (thresholdInputTokens * baseInputRate + outputTokens * 30) / 1_000_000,
        8,
      );
      expect(longCost).toBeCloseTo(
        (longInputTokens * longInputRate + outputTokens * 45) / 1_000_000,
        8,
      );
    },
  );
});
