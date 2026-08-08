import { v } from "convex/values";
import { action, internalQuery, mutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getEffectiveUserId } from "./lib/auth";
import { rateLimiter } from "./rateLimits";
import { decrypt } from "./tonal/encryption";
import { isValidProvider, type ProviderId } from "./ai/providers";
import {
  isValidProviderBudgetLimitUsd,
  MAX_PROVIDER_BUDGET_LIMIT_USD,
  MIN_PROVIDER_BUDGET_LIMIT_USD,
  resolveAiBudgetPreferences,
} from "../lib/aiBudgetPreferences";
import {
  aiBudgetPreferencesValidator,
  providerIdValidator,
  type ProviderKeyInfo,
  type ProviderSettings,
  providerSettingsValidator,
} from "./byokShared";

type RawKeyEntry = { encrypted?: string; addedAt?: number };

const rawKeyEntryValidator = v.object({
  encrypted: v.optional(v.string()),
  addedAt: v.optional(v.number()),
});

const rawProviderSettingsValidator = v.union(
  v.null(),
  v.object({
    selectedProvider: providerIdValidator,
    modelOverride: v.union(v.string(), v.null()),
    budgetPreferences: aiBudgetPreferencesValidator,
    keys: v.object({
      gemini: rawKeyEntryValidator,
      claude: rawKeyEntryValidator,
      openai: rawKeyEntryValidator,
      openrouter: rawKeyEntryValidator,
    }),
  }),
);

export const _getAllProviderKeysRaw = internalQuery({
  args: {},
  returns: rawProviderSettingsValidator,
  handler: async (ctx) => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return null;
    const p = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!p) return null;

    const sp: ProviderId =
      p.selectedProvider && isValidProvider(p.selectedProvider) ? p.selectedProvider : "gemini";

    return {
      selectedProvider: sp,
      modelOverride: p.modelOverride ?? null,
      budgetPreferences: resolveAiBudgetPreferences({
        ignoreBudget: p.ignoreAiProviderBudget,
        providerLimitOverridesUsd: p.aiProviderBudgetLimitsUsd,
      }),
      keys: {
        gemini: { encrypted: p.geminiApiKeyEncrypted, addedAt: p.geminiApiKeyAddedAt },
        claude: { encrypted: p.claudeApiKeyEncrypted, addedAt: p.claudeApiKeyAddedAt },
        openai: { encrypted: p.openaiApiKeyEncrypted, addedAt: p.openaiApiKeyAddedAt },
        openrouter: { encrypted: p.openrouterApiKeyEncrypted, addedAt: p.openrouterApiKeyAddedAt },
      } satisfies Record<ProviderId, RawKeyEntry>,
    };
  },
});

export const getProviderSettings = action({
  args: {},
  returns: v.union(v.null(), providerSettingsValidator),
  handler: async (ctx): Promise<ProviderSettings | null> => {
    const userId = await ctx.runQuery(internal.lib.auth.resolveEffectiveUserId, {});
    if (!userId) return null;

    await rateLimiter.limit(ctx, "getProviderSettings", { key: userId, throws: true });

    const raw = await ctx.runQuery(internal.byokProvider._getAllProviderKeysRaw, {});
    if (!raw) return null;

    const encKey = process.env.TOKEN_ENCRYPTION_KEY;
    if (!encKey) throw new Error("Server misconfigured: TOKEN_ENCRYPTION_KEY not set");

    const providerIds: readonly ProviderId[] = ["gemini", "claude", "openai", "openrouter"];
    const keys = {} as Record<ProviderId, ProviderKeyInfo>;
    for (const pid of providerIds) {
      const entry = raw.keys[pid];
      if (!entry.encrypted) {
        keys[pid] = { hasKey: false };
      } else {
        const d = await decrypt(entry.encrypted, encKey);
        keys[pid] = { hasKey: true, maskedLast4: d.slice(-4), addedAt: entry.addedAt ?? 0 };
      }
    }
    return {
      selectedProvider: raw.selectedProvider,
      modelOverride: raw.modelOverride,
      budgetPreferences: raw.budgetPreferences,
      keys,
    };
  },
});

export const setIgnoreBudget = mutation({
  args: { ignoreBudget: v.boolean() },
  returns: aiBudgetPreferencesValidator,
  handler: async (ctx, { ignoreBudget }) => {
    const profile = await getAuthenticatedProfile(ctx);
    await rateLimiter.limit(ctx, "setBudgetPreference", { key: profile.userId, throws: true });
    await ctx.db.patch(profile._id, { ignoreAiProviderBudget: ignoreBudget });
    return resolveAiBudgetPreferences({
      ignoreBudget,
      providerLimitOverridesUsd: profile.aiProviderBudgetLimitsUsd,
    });
  },
});

export const setSelectedProviderBudgetLimit = mutation({
  args: { budgetLimitUsd: v.number() },
  returns: aiBudgetPreferencesValidator,
  handler: async (ctx, { budgetLimitUsd }) => {
    const profile = await getAuthenticatedProfile(ctx);
    await rateLimiter.limit(ctx, "setBudgetPreference", { key: profile.userId, throws: true });
    if (!isValidProviderBudgetLimitUsd(budgetLimitUsd)) {
      throw new Error(
        `Budget threshold must be between $${MIN_PROVIDER_BUDGET_LIMIT_USD.toFixed(2)} and $${MAX_PROVIDER_BUDGET_LIMIT_USD.toFixed(2)}`,
      );
    }

    const provider: ProviderId =
      profile.selectedProvider && isValidProvider(profile.selectedProvider)
        ? profile.selectedProvider
        : "gemini";
    const providerLimitOverridesUsd = {
      ...profile.aiProviderBudgetLimitsUsd,
      [provider]: budgetLimitUsd,
    };
    await ctx.db.patch(profile._id, { aiProviderBudgetLimitsUsd: providerLimitOverridesUsd });
    return resolveAiBudgetPreferences({
      ignoreBudget: profile.ignoreAiProviderBudget,
      providerLimitOverridesUsd,
    });
  },
});

async function getAuthenticatedProfile(ctx: MutationCtx): Promise<Doc<"userProfiles">> {
  const userId = await getEffectiveUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .unique();
  if (!profile) throw new Error("User profile not found");
  return profile;
}
