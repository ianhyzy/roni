import { getModelForTier, MODEL_TIERS, type ProviderId } from "./providers";

export interface ModelPricing {
  inputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  outputUsdPerMillion: number;
}

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
  pricingEntry("openrouter", ["auto"], [5, 0.5, 5, 25]),
  pricingEntry("openai", ["gpt-5.6-luna"], [1, 0.1, 1.25, 6]),
  pricingEntry("openai", ["gpt-5.6-terra"], [2.5, 0.25, 3.125, 15]),
  pricingEntry("openai", ["gpt-5.6-sol"], [5, 0.5, 6.25, 30]),
  pricingEntry("openai", ["gpt-5.4-nano"], [0.2, 0.02, 0.2, 1.25]),
  pricingEntry("openai", ["gpt-5.4-mini"], [0.75, 0.075, 0.75, 4.5]),
  pricingEntry("openai", ["gpt-5.4"], [2.5, 0.25, 2.5, 15]),
  pricingEntry("claude", ["claude-opus-5"], [5, 0.5, 6.25, 25]),
  pricingEntry("claude", ["claude-sonnet-5"], [3, 0.3, 3.75, 15]),
  pricingEntry(
    "claude",
    ["claude-opus-4-7", "claude-opus-4.7", "claude-opus-4-6", "claude-opus-4.6"],
    [5, 0.5, 6.25, 25],
  ),
  pricingEntry("claude", ["claude-sonnet-4-6", "claude-sonnet-4.6"], [3, 0.3, 3.75, 15]),
  pricingEntry("claude", ["claude-haiku-4-5", "claude-haiku-4.5"], [1, 0.1, 1.25, 5]),
  pricingEntry("gemini", ["gemini-3.5-flash-lite"], [0.3, 0.03, 0.03, 2.5]),
  pricingEntry("gemini", ["gemini-3.6-flash"], [1.5, 0.15, 0.15, 7.5]),
  pricingEntry("gemini", ["gemini-2.5-pro"], [2.5, 0.25, 0.25, 15]),
  pricingEntry("gemini", ["gemini-2.5-flash-lite"], [0.1, 0.01, 0.01, 0.4]),
  pricingEntry("gemini", ["gemini-2.5-flash"], [0.3, 0.03, 0.03, 2.5]),
];

export function getModelPricing(provider: ProviderId, modelId: string): ModelPricing | undefined {
  const reference = parseModelReference(modelId);
  if (!reference) return undefined;
  const pricingProvider = resolvePricingProvider(provider, reference);
  if (!pricingProvider) return undefined;

  return MODEL_PRICING.find(
    (entry) =>
      entry.provider === pricingProvider &&
      entry.matches.some((family) => matchesModelFamily(reference.modelId, family)),
  )?.pricing;
}

export function getConservativeModelPricing(provider: ProviderId): ModelPricing {
  if (provider === "openrouter") {
    return componentWiseMaximum(MODEL_PRICING.map(({ pricing }) => pricing));
  }

  const pricing = MODEL_TIERS.map((tier) =>
    getModelPricing(provider, getModelForTier(provider, tier)),
  ).filter((value): value is ModelPricing => value !== undefined);
  if (pricing.length === 0)
    throw new Error(`No model pricing configured for provider: ${provider}`);

  return componentWiseMaximum(pricing);
}

function pricingEntry(
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
  return modelId.startsWith(`${family}-`) && /^\d{8}$/.test(revision);
}

function componentWiseMaximum(pricing: readonly ModelPricing[]): ModelPricing {
  return {
    inputUsdPerMillion: Math.max(...pricing.map((rate) => rate.inputUsdPerMillion)),
    cacheReadUsdPerMillion: Math.max(...pricing.map((rate) => rate.cacheReadUsdPerMillion)),
    cacheWriteUsdPerMillion: Math.max(...pricing.map((rate) => rate.cacheWriteUsdPerMillion)),
    outputUsdPerMillion: Math.max(...pricing.map((rate) => rate.outputUsdPerMillion)),
  };
}
