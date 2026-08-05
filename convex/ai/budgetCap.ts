import type { StepResult, StopCondition, ToolSet } from "ai";
import {
  getConservativeModelPricing,
  getModelPricing,
  type ModelPricing,
  type ProviderId,
} from "./providers";
import { DEFAULT_PROVIDER_BUDGET_LIMITS_USD } from "../../lib/aiBudgetPreferences";

export interface BudgetCapTrip {
  estimatedCostUsd: number;
  modelId?: string;
  stepCount: number;
}

type StepModelInput = Partial<Pick<StepResult<ToolSet>, "model" | "response">>;
type StepCostInput = Pick<StepResult<ToolSet>, "usage"> & StepModelInput;

export function estimateInteractionCostUsd(
  steps: ReadonlyArray<StepCostInput>,
  provider: ProviderId,
): number {
  return steps.reduce((total, step) => {
    const pricing = getPricingForStep(provider, step);
    const inputTokens = step.usage?.inputTokens ?? 0;
    const cacheReadTokens = step.usage?.inputTokenDetails?.cacheReadTokens ?? 0;
    const cacheWriteTokens = step.usage?.inputTokenDetails?.cacheWriteTokens ?? 0;
    const noCacheTokens =
      step.usage?.inputTokenDetails?.noCacheTokens ??
      Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
    const outputTokens = step.usage?.outputTokens ?? 0;
    return (
      total +
      (noCacheTokens * pricing.inputUsdPerMillion +
        cacheReadTokens * pricing.cacheReadUsdPerMillion +
        cacheWriteTokens * pricing.cacheWriteUsdPerMillion +
        outputTokens * pricing.outputUsdPerMillion) /
        1_000_000
    );
  }, 0);
}

function getStepModelId(step: StepModelInput): string | undefined {
  return getResponseModelId(step.response) ?? step.model?.modelId;
}

function getResponseModelId(response: StepModelInput["response"]): string | undefined {
  if (!response || typeof response !== "object" || !("model" in response)) return undefined;
  const model = response.model;
  if (!model || typeof model !== "object" || !("modelId" in model)) return undefined;
  return typeof model.modelId === "string" ? model.modelId : undefined;
}

function getPricingForStep(provider: ProviderId, step: StepModelInput): ModelPricing {
  const modelId = getStepModelId(step);
  if (!modelId) return getConservativeModelPricing(provider);
  return getModelPricing(provider, modelId) ?? getConservativeModelPricing(provider);
}

export function budgetCapStopCondition(args: {
  provider: ProviderId;
  maxInteractionUsd?: number;
  onTrip?: (trip: BudgetCapTrip) => void;
}): StopCondition<ToolSet> {
  const {
    provider,
    maxInteractionUsd = DEFAULT_PROVIDER_BUDGET_LIMITS_USD[args.provider],
    onTrip,
  } = args;
  let tripped = false;

  return ({ steps }) => {
    if (tripped) return true;

    const estimatedCostUsd = estimateInteractionCostUsd(steps, provider);
    if (estimatedCostUsd < maxInteractionUsd) return false;

    tripped = true;
    const lastStep = steps[steps.length - 1];
    onTrip?.({
      estimatedCostUsd,
      modelId: lastStep ? getStepModelId(lastStep) : undefined,
      stepCount: steps.length,
    });
    return true;
  };
}
