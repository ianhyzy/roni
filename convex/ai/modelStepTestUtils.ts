import type { StepResult, ToolSet } from "ai";

type ModelStep = StepResult<ToolSet>;

export type InputBillingClass = "uncached" | "cache_read" | "cache_write";

interface ModelStepOptions {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly provider?: string;
  readonly modelId?: string;
  readonly responseModelId?: string;
  readonly billingClass?: InputBillingClass;
  readonly stepNumber?: number;
}

export function createModelStep({
  inputTokens,
  outputTokens,
  provider = "openai",
  modelId = "gpt-5.4",
  responseModelId = modelId,
  billingClass = "uncached",
  stepNumber = 0,
}: ModelStepOptions): ModelStep {
  return {
    stepNumber,
    model: { provider, modelId },
    functionId: undefined,
    metadata: undefined,
    experimental_context: undefined,
    content: [],
    text: "",
    reasoning: [],
    reasoningText: undefined,
    files: [],
    sources: [],
    toolCalls: [],
    staticToolCalls: [],
    dynamicToolCalls: [],
    toolResults: [],
    staticToolResults: [],
    dynamicToolResults: [],
    finishReason: "stop",
    rawFinishReason: undefined,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      inputTokenDetails: {
        noCacheTokens: billingClass === "uncached" ? inputTokens : 0,
        cacheReadTokens: billingClass === "cache_read" ? inputTokens : 0,
        cacheWriteTokens: billingClass === "cache_write" ? inputTokens : 0,
      },
      outputTokenDetails: {
        textTokens: outputTokens,
        reasoningTokens: 0,
      },
    },
    warnings: undefined,
    request: {},
    response: {
      id: `response-${stepNumber}`,
      timestamp: new Date(0),
      modelId: responseModelId,
      messages: [],
    },
    providerMetadata: undefined,
  };
}
