import { type Infer, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { getProviderConfig, type ProviderId } from "./ai/providers";

export const providerIdValidator = v.union(
  v.literal("gemini"),
  v.literal("claude"),
  v.literal("openai"),
  v.literal("openrouter"),
);

export const aiBudgetPreferencesValidator = v.object({
  ignoreBudget: v.boolean(),
  providerLimitsUsd: v.object({
    gemini: v.number(),
    claude: v.number(),
    openai: v.number(),
    openrouter: v.number(),
  }),
});

const providerKeyInfoValidator = v.union(
  v.object({ hasKey: v.literal(false) }),
  v.object({
    hasKey: v.literal(true),
    maskedLast4: v.string(),
    addedAt: v.number(),
  }),
);

export const providerSettingsValidator = v.object({
  selectedProvider: providerIdValidator,
  modelOverride: v.union(v.string(), v.null()),
  keys: v.object({
    gemini: providerKeyInfoValidator,
    claude: providerKeyInfoValidator,
    openai: providerKeyInfoValidator,
    openrouter: providerKeyInfoValidator,
  }),
  budgetPreferences: aiBudgetPreferencesValidator,
});

export type ProviderKeyResult = {
  provider: ProviderId;
  apiKey: string;
  modelOverride?: string;
  isHouseKey?: boolean;
};

export type ProviderKeyInfo = Infer<typeof providerKeyInfoValidator>;

export type ProviderSettings = Infer<typeof providerSettingsValidator>;

export const KEY_FIELD_MAP: Record<ProviderId, keyof Doc<"userProfiles">> = {
  gemini: "geminiApiKeyEncrypted",
  claude: "claudeApiKeyEncrypted",
  openai: "openaiApiKeyEncrypted",
  openrouter: "openrouterApiKeyEncrypted",
};

export function normalizeModelOverride(
  modelOverride: string | null | undefined,
): string | undefined {
  const trimmed = modelOverride?.trim();
  return trimmed ? trimmed : undefined;
}

export function assertProviderHasRequiredModel(
  provider: ProviderId,
  modelOverride: string | undefined,
): void {
  if (!modelOverride && !getProviderConfig(provider).primaryModel) {
    throw new Error("byok_model_missing");
  }
}

export function getModelOverrideForProvider(
  provider: ProviderId,
  modelOverride: string | undefined,
): string | undefined {
  return provider === "openrouter" ? modelOverride : undefined;
}
