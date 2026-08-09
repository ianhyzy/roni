import { describe, expect, it, vi } from "vitest";
import { budgetCapStopCondition, estimateAttemptCostUsd } from "./budgetCap";
import { createModelStep, type InputBillingClass } from "./modelStepTestUtils";
import { MAX_PROMPT_INPUT_BUDGET_TOKENS, PROVIDER_IDS, type ProviderId } from "./providers";
import { COACH_MAX_OUTPUT_TOKENS, COACH_MAX_STEPS } from "./turnLimits";
import { DEFAULT_PROVIDER_BUDGET_LIMITS_USD } from "../../lib/aiBudgetPreferences";

const INPUT_BILLING_CLASSES: readonly InputBillingClass[] = [
  "uncached",
  "cache_read",
  "cache_write",
];
// The context builder targets 500k estimated input tokens initially. This
// reference adds 25% headroom for loop growth; it is intentionally not a
// runtime ceiling because raw tool results can grow the prompt further.
const REFERENCE_STEP_INPUT_TOKENS = Math.floor(MAX_PROMPT_INPUT_BUDGET_TOKENS * 1.25);
const REFERENCE_ATTEMPT_COST_USD: Readonly<Record<ProviderId, number>> = {
  gemini: 24.2055,
  claude: 100.21625,
  openai: 199.9205,
  openrouter: 199.9205,
};

function createReferenceAttemptSteps(provider: ProviderId, billingClass: InputBillingClass) {
  return Array.from({ length: COACH_MAX_STEPS }, (_, stepNumber) =>
    createModelStep({
      inputTokens: REFERENCE_STEP_INPUT_TOKENS,
      outputTokens: COACH_MAX_OUTPUT_TOKENS,
      provider,
      modelId: "unknown",
      billingClass,
      stepNumber,
    }),
  );
}

describe("default provider budget thresholds", () => {
  it.each(PROVIDER_IDS)(
    "permits the 25-step %s reference scenario in every known billing class",
    (provider) => {
      const onTrip = vi.fn();
      const stopWhen = budgetCapStopCondition({ provider, onTrip });
      const estimates: number[] = [];

      for (const billingClass of INPUT_BILLING_CLASSES) {
        const steps = createReferenceAttemptSteps(provider, billingClass);
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
    const steps = Array.from({ length: COACH_MAX_STEPS }, (_, stepNumber) => {
      const inputTokens = Math.round(MAX_PROMPT_INPUT_BUDGET_TOKENS + growthPerStep * stepNumber);
      return createModelStep({
        inputTokens,
        outputTokens: COACH_MAX_OUTPUT_TOKENS,
        modelId: "unknown",
        billingClass: "cache_write",
        stepNumber,
      });
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
    const steps = createReferenceAttemptSteps("openai", "cache_write");
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
