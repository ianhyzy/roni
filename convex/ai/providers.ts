import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3 } from "@ai-sdk/provider";

export type ProviderId = "gemini" | "claude" | "openai" | "openrouter";

export const MODEL_TIERS = ["router", "chat", "programming", "summarize"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const PROMPT_OUTPUT_HEADROOM_RATIO = 0.2;

const HIGH_CAPACITY_CONTEXT_WINDOW = 625_000;
const SMALL_CONTEXT_WINDOW = 62_500;
const HIGH_CAPACITY_PROMPT_BUDGET = reserveOutputHeadroom(HIGH_CAPACITY_CONTEXT_WINDOW);
const SMALL_PROMPT_BUDGET = reserveOutputHeadroom(SMALL_CONTEXT_WINDOW);

export interface ModelPricing {
  inputUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  cacheWriteUsdPerMillion: number;
  outputUsdPerMillion: number;
}

type ModelPricingRates = readonly [
  inputUsdPerMillion: number,
  cacheReadUsdPerMillion: number,
  cacheWriteUsdPerMillion: number,
  outputUsdPerMillion: number,
];

function modelPricing(rates: ModelPricingRates): ModelPricing {
  const [inputUsdPerMillion, cacheReadUsdPerMillion, cacheWriteUsdPerMillion, outputUsdPerMillion] =
    rates;
  return {
    inputUsdPerMillion,
    cacheReadUsdPerMillion,
    cacheWriteUsdPerMillion,
    outputUsdPerMillion,
  };
}

export interface ProviderConfig {
  label: string;
  modelPolicy: Record<ModelTier, string>;
  primaryModel: string;
  fallbackModel: string | null;
  keyRegex: RegExp;
  keyFormatError: string;
  keySourceUrl: string;
  /** Where users go to top up or check quota/billing on this provider. */
  billingUrl: string;
  keyPlaceholder: string;
  keyFieldName: string;
  keyTimestampFieldName: string;
  createLanguageModel: (apiKey: string, model: string) => LanguageModelV3;
}

type ProviderConfigInput = Omit<ProviderConfig, "primaryModel" | "fallbackModel"> & {
  fallbackModel?: string | null;
};

function defineProviderConfig(config: ProviderConfigInput): ProviderConfig {
  return {
    ...config,
    primaryModel: config.modelPolicy.chat,
    fallbackModel:
      config.fallbackModel === undefined ? config.modelPolicy.router : config.fallbackModel,
  };
}

function reserveOutputHeadroom(contextWindowTokens: number): number {
  return Math.floor(contextWindowTokens * (1 - PROMPT_OUTPUT_HEADROOM_RATIO));
}

function normalizeModelId(modelId: string): string {
  return modelId.trim().toLowerCase().split("/").pop() ?? modelId.trim().toLowerCase();
}

export function getPromptInputBudget(provider: ProviderId, modelId: string): number {
  const normalized = normalizeModelId(modelId);
  switch (provider) {
    case "openrouter":
      return getKnownPromptInputBudget(normalized) ?? SMALL_PROMPT_BUDGET;
    case "gemini":
      if (normalized.startsWith("gemini-3") || normalized.startsWith("gemini-2.5-")) {
        return HIGH_CAPACITY_PROMPT_BUDGET;
      }
      return SMALL_PROMPT_BUDGET;
    case "claude":
      if (normalized.includes("haiku")) return SMALL_PROMPT_BUDGET;
      if (normalized.includes("sonnet") || normalized.includes("opus")) {
        return HIGH_CAPACITY_PROMPT_BUDGET;
      }
      return SMALL_PROMPT_BUDGET;
    case "openai":
      if (
        normalized === "gpt-5.6" ||
        normalized.startsWith("gpt-5.6-") ||
        normalized === "gpt-5.4" ||
        normalized.startsWith("gpt-5.4-")
      ) {
        return HIGH_CAPACITY_PROMPT_BUDGET;
      }
      return SMALL_PROMPT_BUDGET;
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}

function getKnownPromptInputBudget(normalizedModelId: string): number | undefined {
  if (normalizedModelId.startsWith("gemini-3") || normalizedModelId.startsWith("gemini-2.5-")) {
    return HIGH_CAPACITY_PROMPT_BUDGET;
  }
  if (normalizedModelId.includes("haiku")) return SMALL_PROMPT_BUDGET;
  if (normalizedModelId.includes("sonnet") || normalizedModelId.includes("opus")) {
    return HIGH_CAPACITY_PROMPT_BUDGET;
  }
  if (
    normalizedModelId === "gpt-5.6" ||
    normalizedModelId.startsWith("gpt-5.6-") ||
    normalizedModelId === "gpt-5.4" ||
    normalizedModelId.startsWith("gpt-5.4-")
  ) {
    return HIGH_CAPACITY_PROMPT_BUDGET;
  }
  return undefined;
}

const MODEL_PRICING: ReadonlyArray<{
  matches: readonly string[];
  pricing: ModelPricing;
}> = [
  {
    matches: ["openrouter/auto", "auto"],
    pricing: modelPricing([5, 0.5, 5, 25]),
  },
  {
    matches: ["gpt-5.6-luna"],
    pricing: modelPricing([1, 0.1, 1.25, 6]),
  },
  {
    matches: ["gpt-5.6-terra"],
    pricing: modelPricing([2.5, 0.25, 3.125, 15]),
  },
  {
    matches: ["gpt-5.6-sol"],
    pricing: modelPricing([5, 0.5, 6.25, 30]),
  },
  {
    matches: ["gpt-5.4-nano"],
    pricing: modelPricing([0.2, 0.02, 0.2, 1.25]),
  },
  {
    matches: ["gpt-5.4-mini"],
    pricing: modelPricing([0.75, 0.075, 0.75, 4.5]),
  },
  {
    matches: ["gpt-5.4"],
    pricing: modelPricing([2.5, 0.25, 2.5, 15]),
  },
  {
    matches: ["claude-opus-5"],
    pricing: modelPricing([5, 0.5, 6.25, 25]),
  },
  {
    matches: ["claude-sonnet-5"],
    pricing: modelPricing([3, 0.3, 3.75, 15]),
  },
  {
    matches: ["claude-opus-4-7", "claude-opus-4.7", "claude-opus-4-6", "claude-opus-4.6"],
    pricing: modelPricing([5, 0.5, 6.25, 25]),
  },
  {
    matches: ["claude-sonnet-4-6", "claude-sonnet-4.6"],
    pricing: modelPricing([3, 0.3, 3.75, 15]),
  },
  {
    matches: ["claude-haiku-4-5", "claude-haiku-4.5"],
    pricing: modelPricing([1, 0.1, 1.25, 5]),
  },
  {
    matches: ["gemini-3.5-flash-lite"],
    pricing: modelPricing([0.3, 0.03, 0.03, 2.5]),
  },
  {
    matches: ["gemini-3.6-flash"],
    pricing: modelPricing([1.5, 0.15, 0.15, 7.5]),
  },
  {
    matches: ["gemini-2.5-pro"],
    pricing: modelPricing([2.5, 0.25, 0.25, 15]),
  },
  {
    matches: ["gemini-2.5-flash-lite"],
    pricing: modelPricing([0.1, 0.01, 0.01, 0.4]),
  },
  {
    matches: ["gemini-2.5-flash"],
    pricing: modelPricing([0.3, 0.03, 0.03, 2.5]),
  },
] as const;

export function getModelPricing(provider: ProviderId, modelId: string): ModelPricing | undefined {
  const normalized = normalizeModelId(modelId);
  if (provider === "openrouter" && modelId.trim().toLowerCase() === "openrouter/auto") {
    return MODEL_PRICING[0].pricing;
  }
  return MODEL_PRICING.find((entry) =>
    entry.matches.some((match) => normalized === match || normalized.startsWith(`${match}-`)),
  )?.pricing;
}

export function getConservativeModelPricing(provider: ProviderId): ModelPricing {
  const pricing = MODEL_TIERS.map((tier) =>
    getModelPricing(provider, getModelForTier(provider, tier)),
  ).filter((value): value is ModelPricing => value !== undefined);

  if (pricing.length === 0) {
    throw new Error(`No model pricing configured for provider: ${provider}`);
  }

  return pricing.reduce((mostExpensive, current) =>
    current.inputUsdPerMillion + current.outputUsdPerMillion >
    mostExpensive.inputUsdPerMillion + mostExpensive.outputUsdPerMillion
      ? current
      : mostExpensive,
  );
}

export function isPreviewModelId(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  return (
    normalized.includes("preview") ||
    normalized.includes("latest") ||
    normalized.includes("experimental")
  );
}

export function assertNoPreviewDefaults(): void {
  const offenders = Object.entries(PROVIDERS).flatMap(([provider, config]) =>
    MODEL_TIERS.flatMap((tier) => {
      const modelId = config.modelPolicy[tier];
      return isPreviewModelId(modelId) ? [`${provider}.${tier}=${modelId}`] : [];
    }),
  );

  if (offenders.length > 0) {
    throw new Error(
      `Preview/latest/experimental model ids cannot be defaults: ${offenders.join(", ")}`,
    );
  }
}

export function getFallbackTier(tier: ModelTier): ModelTier {
  switch (tier) {
    case "router":
      return "chat";
    case "chat":
      return "router";
    case "programming":
      return "chat";
    case "summarize":
      return "router";
    default: {
      const _exhaustive: never = tier;
      return _exhaustive;
    }
  }
}

export function getModelForTier(
  provider: ProviderId,
  tier: ModelTier,
  modelOverride?: string,
): string {
  const override = modelOverride?.trim();
  if (provider === "openrouter" && override) return override;
  return getProviderConfig(provider).modelPolicy[tier];
}

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  gemini: defineProviderConfig({
    label: "Google Gemini",
    modelPolicy: {
      router: "gemini-3.5-flash-lite",
      chat: "gemini-3.6-flash",
      programming: "gemini-3.6-flash",
      summarize: "gemini-3.5-flash-lite",
    },
    keyRegex: /^(?:AIza[A-Za-z0-9_-]{35}|AQ\.?[A-Za-z0-9_-]{20,})$/,
    keyFormatError: "Key format looks wrong. Gemini keys start with 'AIza' or 'AQ'.",
    keySourceUrl: "https://aistudio.google.com/app/apikey",
    billingUrl: "https://aistudio.google.com/app/apikey",
    keyPlaceholder: "AQ... or AIza...",
    keyFieldName: "geminiApiKeyEncrypted",
    keyTimestampFieldName: "geminiApiKeyAddedAt",
    createLanguageModel: (apiKey, model) => {
      const provider = createGoogleGenerativeAI({ apiKey });
      return provider(model);
    },
  }),
  claude: defineProviderConfig({
    label: "Anthropic Claude",
    modelPolicy: {
      router: "claude-haiku-4-5",
      chat: "claude-sonnet-5",
      programming: "claude-opus-5",
      summarize: "claude-haiku-4-5",
    },
    keyRegex: /^sk-ant-/,
    keyFormatError: "Key format looks wrong. Claude keys start with 'sk-ant-'.",
    keySourceUrl: "https://console.anthropic.com/settings/keys",
    billingUrl: "https://console.anthropic.com/settings/billing",
    keyPlaceholder: "sk-ant-...",
    keyFieldName: "claudeApiKeyEncrypted",
    keyTimestampFieldName: "claudeApiKeyAddedAt",
    createLanguageModel: (apiKey, model) => {
      const provider = createAnthropic({ apiKey });
      return provider(model);
    },
  }),
  openai: defineProviderConfig({
    label: "OpenAI",
    modelPolicy: {
      router: "gpt-5.6-luna",
      chat: "gpt-5.6-terra",
      programming: "gpt-5.6-sol",
      summarize: "gpt-5.6-luna",
    },
    keyRegex: /^sk-(?!ant-)(?!or-)/,
    keyFormatError:
      "Key format looks wrong. OpenAI keys start with 'sk-' (but not 'sk-ant-' or 'sk-or-').",
    keySourceUrl: "https://platform.openai.com/api-keys",
    billingUrl: "https://platform.openai.com/settings/organization/billing",
    keyPlaceholder: "sk-...",
    keyFieldName: "openaiApiKeyEncrypted",
    keyTimestampFieldName: "openaiApiKeyAddedAt",
    createLanguageModel: (apiKey, model) => {
      const provider = createOpenAI({ apiKey });
      return provider(model);
    },
  }),
  openrouter: defineProviderConfig({
    label: "OpenRouter",
    modelPolicy: {
      router: "openrouter/auto",
      chat: "openrouter/auto",
      programming: "openrouter/auto",
      summarize: "openrouter/auto",
    },
    fallbackModel: null,
    keyRegex: /^sk-or-/,
    keyFormatError: "Key format looks wrong. OpenRouter keys start with 'sk-or-'.",
    keySourceUrl: "https://openrouter.ai/keys",
    billingUrl: "https://openrouter.ai/credits",
    keyPlaceholder: "sk-or-...",
    keyFieldName: "openrouterApiKeyEncrypted",
    keyTimestampFieldName: "openrouterApiKeyAddedAt",
    createLanguageModel: (apiKey, model) => {
      const provider = createOpenAI({
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
      });
      return provider.chat(model);
    },
  }),
};

assertNoPreviewDefaults();

export function getProviderConfig(provider: ProviderId): ProviderConfig {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);
  return config;
}

export function validateKeyFormat(provider: ProviderId, key: string): boolean {
  const config = PROVIDERS[provider];
  if (!config) return false;
  return config.keyRegex.test(key);
}

export function isValidProvider(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}
