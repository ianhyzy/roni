import { describe, expect, it, vi } from "vitest";
import { budgetCapStopCondition, estimateAttemptCostUsd } from "./budgetCap";
import { getConservativeModelPricing } from "./modelPricing";
import { MAX_PROMPT_INPUT_BUDGET_TOKENS, type ProviderId } from "./providers";
import { COACH_MAX_OUTPUT_TOKENS, COACH_MAX_STEPS } from "./turnLimits";
import { DEFAULT_PROVIDER_BUDGET_LIMITS_USD } from "../../lib/aiBudgetPreferences";

type BudgetStopSteps = Parameters<ReturnType<typeof budgetCapStopCondition>>[0]["steps"];

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

  it("uses conservative provider pricing for a model from the wrong provider", () => {
    const cost = estimateAttemptCostUsd(
      [
        {
          usage: { inputTokens: 10_000, outputTokens: 2_000 },
          model: { provider: "gemini", modelId: "openai/gpt-5.4-nano" },
        },
      ] as unknown as Parameters<typeof estimateAttemptCostUsd>[0],
      "gemini",
    );

    expect(cost).toBeCloseTo(0.03, 6);
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

    const firstStep = {
      usage: { inputTokens: 10_000, outputTokens: 2_000 },
      model: { provider: "openai", modelId: "gpt-5.4" },
    } as unknown as BudgetStopSteps[number];
    const secondStep = {
      usage: { inputTokens: 5_000, outputTokens: 3_000 },
      model: { provider: "openai", modelId: "gpt-5.4" },
    } as unknown as BudgetStopSteps[number];

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

  it("does not fire while cost stays under the configured limit", () => {
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

describe("default provider budget thresholds", () => {
  const PROVIDERS: readonly ProviderId[] = ["gemini", "claude", "openai", "openrouter"];
  const INPUT_BILLING_CLASSES = ["uncached", "cache_read", "cache_write"] as const;
  // The context builder targets 500k estimated input tokens initially. This
  // reference adds 25% headroom for loop growth; it is intentionally not a
  // runtime ceiling because raw tool results can grow the prompt further.
  const REFERENCE_STEP_INPUT_TOKENS = Math.floor(MAX_PROMPT_INPUT_BUDGET_TOKENS * 1.25);
  const REFERENCE_ATTEMPT_COST_USD: Readonly<Record<ProviderId, number>> = {
    gemini: 24.2055,
    claude: 100.21625,
    openai: 100.72825,
    openrouter: 100.72825,
  };

  function referenceAttemptSteps(
    provider: ProviderId,
    billingClass: (typeof INPUT_BILLING_CLASSES)[number],
  ) {
    const inputTokenDetails = {
      noCacheTokens: billingClass === "uncached" ? REFERENCE_STEP_INPUT_TOKENS : 0,
      cacheReadTokens: billingClass === "cache_read" ? REFERENCE_STEP_INPUT_TOKENS : 0,
      cacheWriteTokens: billingClass === "cache_write" ? REFERENCE_STEP_INPUT_TOKENS : 0,
    };
    return Array.from({ length: COACH_MAX_STEPS }, () => ({
      usage: {
        inputTokens: REFERENCE_STEP_INPUT_TOKENS,
        outputTokens: COACH_MAX_OUTPUT_TOKENS,
        inputTokenDetails,
      },
      model: { provider, modelId: undefined },
    })) as unknown as BudgetStopSteps;
  }

  it.each(PROVIDERS)(
    "permits the 25-step %s reference scenario in every known billing class",
    (provider) => {
      const onTrip = vi.fn();
      const stopWhen = budgetCapStopCondition({ provider, onTrip });
      const estimates: number[] = [];

      expect(getConservativeModelPricing(provider)).toBeDefined();
      for (const billingClass of INPUT_BILLING_CLASSES) {
        const steps = referenceAttemptSteps(provider, billingClass);
        const referenceAttemptUsd = estimateAttemptCostUsd(steps, provider);
        estimates.push(referenceAttemptUsd);

        expect(stopWhen({ steps })).toBe(false);
        expect(DEFAULT_PROVIDER_BUDGET_LIMITS_USD[provider]).toBeGreaterThan(referenceAttemptUsd);
      }
      expect(Math.max(...estimates)).toBeCloseTo(REFERENCE_ATTEMPT_COST_USD[provider], 6);
      expect(onTrip).not.toHaveBeenCalled();
    },
  );

  it("can stop before the step limit when tool-loop input outgrows the reference", () => {
    const onTrip = vi.fn();
    const stopWhen = budgetCapStopCondition({ provider: "openai", onTrip });
    const finalInputTokens = MAX_PROMPT_INPUT_BUDGET_TOKENS * 2;
    const growthPerStep =
      (finalInputTokens - MAX_PROMPT_INPUT_BUDGET_TOKENS) / (COACH_MAX_STEPS - 1);
    const steps = Array.from({ length: COACH_MAX_STEPS }, (_, index) => {
      const inputTokens = Math.round(MAX_PROMPT_INPUT_BUDGET_TOKENS + growthPerStep * index);
      return {
        usage: {
          inputTokens,
          outputTokens: COACH_MAX_OUTPUT_TOKENS,
          inputTokenDetails: { cacheWriteTokens: inputTokens },
        },
        model: { provider: "openai", modelId: undefined },
      } as unknown as BudgetStopSteps[number];
    });

    let stoppedAt: number | undefined;
    for (let stepCount = 1; stepCount <= steps.length; stepCount += 1) {
      if (stopWhen({ steps: steps.slice(0, stepCount) })) {
        stoppedAt = stepCount;
        break;
      }
    }

    expect(stoppedAt).toBeLessThan(COACH_MAX_STEPS);
    expect(onTrip).toHaveBeenCalledOnce();
  });

  it("stops when a completed attempt estimate exactly equals the configured threshold", () => {
    const steps = referenceAttemptSteps("openai", "cache_write");
    const estimatedCostUsd = estimateAttemptCostUsd(steps, "openai");
    const onTrip = vi.fn();
    const stopWhen = budgetCapStopCondition({
      provider: "openai",
      maxAttemptUsd: estimatedCostUsd,
      onTrip,
    });

    expect(stopWhen({ steps })).toBe(true);
    expect(onTrip).toHaveBeenCalledOnce();
  });
});
