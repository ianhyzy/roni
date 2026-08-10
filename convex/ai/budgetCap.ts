import type { StepResult, StopCondition, ToolSet } from "ai";
import { estimateModelRequestCostUsd } from "./modelPricing";
import type { ProviderId } from "./providers";
import { DEFAULT_PROVIDER_BUDGET_LIMITS_USD } from "../../lib/aiBudgetPreferences";

export interface BudgetCapTrip {
  estimatedCostUsd: number;
  modelId?: string;
  stepCount: number;
}

type StepModelInput = Partial<Pick<StepResult<ToolSet>, "model" | "response">>;
type StepCostInput = Pick<StepResult<ToolSet>, "usage"> & StepModelInput;

/** Estimate cumulative model cost within one streamText attempt. */
export function estimateAttemptCostUsd(
  steps: ReadonlyArray<StepCostInput>,
  provider: ProviderId,
): number {
  return steps.reduce(
    (total, step) =>
      total +
      estimateModelRequestCostUsd({
        provider,
        requestedModelId: step.model?.modelId,
        responseModelId: step.response?.modelId,
        inputTokens: step.usage?.inputTokens ?? 0,
        outputTokens: step.usage?.outputTokens ?? 0,
        noCacheTokens: step.usage?.inputTokenDetails?.noCacheTokens,
        cacheReadTokens: step.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheWriteTokens: step.usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      }),
    0,
  );
}

function getStepModelId(step: StepModelInput): string | undefined {
  return step.response?.modelId ?? step.model?.modelId;
}

export function budgetCapStopCondition(args: {
  provider: ProviderId;
  maxAttemptUsd?: number;
  onTrip?: (trip: BudgetCapTrip) => void;
}): StopCondition<ToolSet> {
  const {
    provider,
    maxAttemptUsd = DEFAULT_PROVIDER_BUDGET_LIMITS_USD[args.provider],
    onTrip,
  } = args;
  let tripped = false;

  return ({ steps }) => {
    if (tripped) return true;

    const estimatedCostUsd = estimateAttemptCostUsd(steps, provider);
    if (estimatedCostUsd < maxAttemptUsd) return false;

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
