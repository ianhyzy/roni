import { getModelForTier, MODEL_TIERS, type ProviderId } from "./providers";

export interface ModelPricing {
  readonly inputUsdPerMillion: number;
  readonly cacheReadUsdPerMillion: number;
  readonly cacheWriteUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
}

export const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS = 272_000;
const OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER = 2;
const OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER = 1.5;

type DirectProviderId = Exclude<ProviderId, "openrouter">;
type ModelPricingRates = readonly [
  inputUsdPerMillion: number,
  cacheReadUsdPerMillion: number,
  cacheWriteUsdPerMillion: number,
  outputUsdPerMillion: number,
];

interface ModelReference {
  readonly vendor?: string;
  readonly modelId: string;
}

interface ModelPricingEntry {
  readonly provider: ProviderId;
  readonly matches: readonly string[];
  readonly pricing: ModelPricing;
}

interface ResolvedModelPricing {
  readonly pricingProvider: ProviderId;
  readonly modelId: string;
  readonly pricing: ModelPricing;
}

interface EffectiveModelPricingArgs {
  readonly provider: ProviderId;
  readonly modelId?: string;
  readonly inputTokens: number;
}

export interface ModelRequestCostInput {
  readonly provider: ProviderId;
  readonly requestedModelId?: string;
  readonly responseModelId?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly noCacheTokens?: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

const DIRECT_PROVIDER_PREFIXES: Readonly<Record<DirectProviderId, readonly string[]>> = {
  gemini: ["google", "models"],
  claude: ["anthropic"],
  openai: ["openai"],
};

const OPENROUTER_VENDOR_PROVIDERS: Readonly<Record<string, ProviderId>> = {
  openrouter: "openrouter",
  google: "gemini",
  anthropic: "claude",
  openai: "openai",
};

const MODEL_PRICING: readonly ModelPricingEntry[] = [
  createPricingEntry("openrouter", ["auto"], [5, 0.5, 6.25, 30]),
  createPricingEntry("openai", ["gpt-5.6-luna"], [0.2, 0.02, 0.25, 1.2]),
  createPricingEntry("openai", ["gpt-5.6-terra"], [2, 0.2, 2.5, 12]),
  createPricingEntry("openai", ["gpt-5.6-sol"], [5, 0.5, 6.25, 30]),
  // OpenAI publishes no distinct GPT-5.4-family cache-write rate, so use uncached input as a proxy.
  createPricingEntry("openai", ["gpt-5.4-nano"], [0.2, 0.02, 0.2, 1.25]),
  createPricingEntry("openai", ["gpt-5.4-mini"], [0.75, 0.075, 0.75, 4.5]),
  createPricingEntry("openai", ["gpt-5.4"], [2.5, 0.25, 2.5, 15]),
  createPricingEntry("claude", ["claude-opus-5"], [5, 0.5, 6.25, 25]),
  createPricingEntry("claude", ["claude-sonnet-5"], [3, 0.3, 3.75, 15]),
  createPricingEntry(
    "claude",
    ["claude-opus-4-7", "claude-opus-4.7", "claude-opus-4-6", "claude-opus-4.6"],
    [5, 0.5, 6.25, 25],
  ),
  createPricingEntry("claude", ["claude-sonnet-4-6", "claude-sonnet-4.6"], [3, 0.3, 3.75, 15]),
  createPricingEntry("claude", ["claude-haiku-4-5", "claude-haiku-4.5"], [1, 0.1, 1.25, 5]),
  createPricingEntry("gemini", ["gemini-3.5-flash-lite"], [0.3, 0.03, 0.03, 2.5]),
  createPricingEntry("gemini", ["gemini-3.6-flash"], [1.5, 0.15, 0.15, 7.5]),
  createPricingEntry("gemini", ["gemini-2.5-pro"], [2.5, 0.25, 0.25, 15]),
  createPricingEntry("gemini", ["gemini-2.5-flash-lite"], [0.1, 0.01, 0.01, 0.4]),
  createPricingEntry("gemini", ["gemini-2.5-flash"], [0.3, 0.03, 0.03, 2.5]),
];

export function getModelPricing(provider: ProviderId, modelId: string): ModelPricing | undefined {
  const reference = parseModelReference(modelId);
  if (!reference) return undefined;
  return resolveModelPricing(provider, reference)?.pricing;
}

export function getEffectiveModelPricing({
  provider,
  modelId,
  inputTokens,
}: EffectiveModelPricingArgs): ModelPricing {
  const reference = modelId ? parseModelReference(modelId) : null;
  const resolved = reference ? resolveModelPricing(provider, reference) : undefined;
  const conservativePricing = getConservativeModelPricing(provider);
  const usesConservativeOpenRouterPricing =
    provider === "openrouter" && (!resolved || resolved.pricingProvider === "openrouter");
  const basePricing = usesConservativeOpenRouterPricing
    ? conservativePricing
    : (resolved?.pricing ?? conservativePricing);
  if (inputTokens <= OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS) return basePricing;

  const usesOpenAiLongContextRates = resolved
    ? resolved.pricingProvider === "openai" && isOpenAiLongContextModel(resolved.modelId)
    : provider === "openai" || provider === "openrouter";
  if (!usesOpenAiLongContextRates && resolved?.pricingProvider !== "openrouter") {
    return basePricing;
  }

  return applyOpenAiLongContextRates(basePricing);
}

export function estimateModelRequestCostUsd(input: ModelRequestCostInput): number {
  const inputTokens = Math.max(0, input.inputTokens);
  const modelId = usesConservativeOpenRouterRouting(input.provider, input.requestedModelId)
    ? input.requestedModelId
    : (input.responseModelId ?? input.requestedModelId);
  const pricing = getEffectiveModelPricing({ provider: input.provider, modelId, inputTokens });
  const cacheReadTokens = Math.max(0, input.cacheReadTokens);
  const cacheWriteTokens = Math.max(0, input.cacheWriteTokens);
  const noCacheTokens =
    input.noCacheTokens === undefined
      ? Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
      : Math.max(0, input.noCacheTokens);

  return (
    (noCacheTokens * pricing.inputUsdPerMillion +
      cacheReadTokens * pricing.cacheReadUsdPerMillion +
      cacheWriteTokens * pricing.cacheWriteUsdPerMillion +
      Math.max(0, input.outputTokens) * pricing.outputUsdPerMillion) /
    1_000_000
  );
}

function usesConservativeOpenRouterRouting(
  provider: ProviderId,
  requestedModelId: string | undefined,
): boolean {
  if (provider !== "openrouter" || !requestedModelId) return provider === "openrouter";
  const reference = parseModelReference(requestedModelId);
  if (!reference) return true;
  const resolved = resolveModelPricing(provider, reference);
  return !resolved || resolved.pricingProvider === "openrouter";
}

export function getConservativeModelPricing(provider: ProviderId): ModelPricing {
  if (provider === "openrouter") {
    return getComponentWiseMaximum(MODEL_PRICING.map(({ pricing }) => pricing));
  }

  const pricing = MODEL_TIERS.map((tier) =>
    getModelPricing(provider, getModelForTier(provider, tier)),
  ).filter((value): value is ModelPricing => value !== undefined);
  if (pricing.length === 0)
    throw new Error(`No model pricing configured for provider: ${provider}`);

  return getComponentWiseMaximum(pricing);
}

function createPricingEntry(
  provider: ProviderId,
  matches: readonly string[],
  rates: ModelPricingRates,
): ModelPricingEntry {
  const [inputUsdPerMillion, cacheReadUsdPerMillion, cacheWriteUsdPerMillion, outputUsdPerMillion] =
    rates;
  return {
    provider,
    matches,
    pricing: {
      inputUsdPerMillion,
      cacheReadUsdPerMillion,
      cacheWriteUsdPerMillion,
      outputUsdPerMillion,
    },
  };
}

function resolveModelPricing(
  requestedProvider: ProviderId,
  reference: ModelReference,
): ResolvedModelPricing | undefined {
  const pricingProvider = resolvePricingProvider(requestedProvider, reference);
  if (!pricingProvider) return undefined;
  const pricing = MODEL_PRICING.find(
    (entry) =>
      entry.provider === pricingProvider &&
      entry.matches.some((family) => matchesModelFamily(reference.modelId, family)),
  )?.pricing;
  return pricing ? { pricingProvider, modelId: reference.modelId, pricing } : undefined;
}

function parseModelReference(modelId: string): ModelReference | null {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) return null;
  const segments = normalized.split("/");
  if (segments.length === 1) return { modelId: segments[0] };
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  return { vendor: segments[0], modelId: segments[1] };
}

function resolvePricingProvider(
  requestedProvider: ProviderId,
  reference: ModelReference,
): ProviderId | null {
  if (requestedProvider === "openrouter") {
    if (!reference.vendor) return reference.modelId === "auto" ? "openrouter" : null;
    return OPENROUTER_VENDOR_PROVIDERS[reference.vendor] ?? null;
  }

  if (reference.vendor && !DIRECT_PROVIDER_PREFIXES[requestedProvider].includes(reference.vendor)) {
    return null;
  }
  return requestedProvider;
}

function matchesModelFamily(modelId: string, family: string): boolean {
  if (family === "auto") return modelId === family;
  if (modelId === family) return true;
  const revision = modelId.slice(family.length + 1);
  return modelId.startsWith(`${family}-`) && /^(?:\d{8}|\d{4}-\d{2}-\d{2})$/.test(revision);
}

function isOpenAiLongContextModel(modelId: string): boolean {
  return ["gpt-5.4", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].some((family) =>
    matchesModelFamily(modelId, family),
  );
}

function applyOpenAiLongContextRates(pricing: ModelPricing): ModelPricing {
  return {
    inputUsdPerMillion: pricing.inputUsdPerMillion * OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER,
    cacheReadUsdPerMillion: pricing.cacheReadUsdPerMillion * OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER,
    cacheWriteUsdPerMillion: pricing.cacheWriteUsdPerMillion * OPENAI_LONG_CONTEXT_INPUT_MULTIPLIER,
    outputUsdPerMillion: pricing.outputUsdPerMillion * OPENAI_LONG_CONTEXT_OUTPUT_MULTIPLIER,
  };
}

function getComponentWiseMaximum(pricing: readonly ModelPricing[]): ModelPricing {
  return {
    inputUsdPerMillion: Math.max(...pricing.map((rate) => rate.inputUsdPerMillion)),
    cacheReadUsdPerMillion: Math.max(...pricing.map((rate) => rate.cacheReadUsdPerMillion)),
    cacheWriteUsdPerMillion: Math.max(...pricing.map((rate) => rate.cacheWriteUsdPerMillion)),
    outputUsdPerMillion: Math.max(...pricing.map((rate) => rate.outputUsdPerMillion)),
  };
}
