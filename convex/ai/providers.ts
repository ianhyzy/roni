import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { GEMINI_API_KEY_PATTERN } from "../../lib/geminiApiKey";

export const PROVIDER_IDS = ["gemini", "claude", "openai", "openrouter"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

const AI_SDK_PROVIDER_IDS: Readonly<Record<string, ProviderId>> = {
  "google.generative-ai": "gemini",
  "anthropic.messages": "claude",
  "openai.responses": "openai",
  // This project uses the OpenAI-compatible chat client only for OpenRouter.
  "openai.chat": "openrouter",
};

export const MODEL_TIERS = ["router", "chat", "programming", "summarize"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const PROMPT_OUTPUT_HEADROOM_RATIO = 0.2;
const HIGH_CAPACITY_CONTEXT_WINDOW_TOKENS = 625_000;
const SMALL_CONTEXT_WINDOW = 62_500;
export const MAX_PROMPT_INPUT_BUDGET_TOKENS = reserveOutputHeadroom(
  HIGH_CAPACITY_CONTEXT_WINDOW_TOKENS,
);
const SMALL_PROMPT_BUDGET = reserveOutputHeadroom(SMALL_CONTEXT_WINDOW);

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
        return MAX_PROMPT_INPUT_BUDGET_TOKENS;
      }
      return SMALL_PROMPT_BUDGET;
    case "claude":
      if (normalized.includes("haiku")) return SMALL_PROMPT_BUDGET;
      if (normalized.includes("sonnet") || normalized.includes("opus")) {
        return MAX_PROMPT_INPUT_BUDGET_TOKENS;
      }
      return SMALL_PROMPT_BUDGET;
    case "openai":
      if (
        normalized === "gpt-5.6" ||
        normalized.startsWith("gpt-5.6-") ||
        normalized === "gpt-5.4" ||
        normalized.startsWith("gpt-5.4-")
      ) {
        return MAX_PROMPT_INPUT_BUDGET_TOKENS;
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
    return MAX_PROMPT_INPUT_BUDGET_TOKENS;
  }
  if (normalizedModelId.includes("haiku")) return SMALL_PROMPT_BUDGET;
  if (normalizedModelId.includes("sonnet") || normalizedModelId.includes("opus")) {
    return MAX_PROMPT_INPUT_BUDGET_TOKENS;
  }
  if (
    normalizedModelId === "gpt-5.6" ||
    normalizedModelId.startsWith("gpt-5.6-") ||
    normalizedModelId === "gpt-5.4" ||
    normalizedModelId.startsWith("gpt-5.4-")
  ) {
    return MAX_PROMPT_INPUT_BUDGET_TOKENS;
  }
  return undefined;
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
    keyRegex: GEMINI_API_KEY_PATTERN,
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

export function resolvePricingProviderId(value: string): ProviderId {
  if (isValidProvider(value)) return value;
  if (!Object.prototype.hasOwnProperty.call(AI_SDK_PROVIDER_IDS, value)) return "openrouter";
  return AI_SDK_PROVIDER_IDS[value] ?? "openrouter";
}
