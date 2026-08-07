export const MIN_PROVIDER_BUDGET_LIMIT_USD = 0.01;
export const MAX_PROVIDER_BUDGET_LIMIT_USD = 100;

export const DEFAULT_PROVIDER_BUDGET_LIMITS_USD = {
  gemini: 0.1,
  claude: 0.1,
  openai: 0.1,
  openrouter: 0.1,
} as const;

type BudgetProviderId = keyof typeof DEFAULT_PROVIDER_BUDGET_LIMITS_USD;

type ProviderBudgetLimitOverridesUsd = Partial<Record<BudgetProviderId, number>>;

export interface AiBudgetPreferences {
  readonly ignoreBudget: boolean;
  readonly providerLimitsUsd: Readonly<Record<BudgetProviderId, number>>;
}

export type AiBudgetPolicy =
  { readonly kind: "disabled" } | { readonly kind: "limit"; readonly maxInteractionUsd: number };

interface ResolveAiBudgetPreferencesArgs {
  readonly ignoreBudget?: boolean;
  readonly providerLimitOverridesUsd?: ProviderBudgetLimitOverridesUsd;
}

export function isValidProviderBudgetLimitUsd(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value >= MIN_PROVIDER_BUDGET_LIMIT_USD &&
    value <= MAX_PROVIDER_BUDGET_LIMIT_USD
  );
}

export function resolveAiBudgetPreferences({
  ignoreBudget = false,
  providerLimitOverridesUsd,
}: ResolveAiBudgetPreferencesArgs = {}): AiBudgetPreferences {
  return {
    ignoreBudget,
    providerLimitsUsd: {
      gemini: resolveProviderLimit("gemini", providerLimitOverridesUsd),
      claude: resolveProviderLimit("claude", providerLimitOverridesUsd),
      openai: resolveProviderLimit("openai", providerLimitOverridesUsd),
      openrouter: resolveProviderLimit("openrouter", providerLimitOverridesUsd),
    },
  };
}

export function resolveAiBudgetPolicy(args: {
  readonly isHouseKey: boolean;
  readonly provider: BudgetProviderId;
  readonly preferences: AiBudgetPreferences;
}): AiBudgetPolicy {
  if (args.isHouseKey || args.preferences.ignoreBudget) return { kind: "disabled" };
  return {
    kind: "limit",
    maxInteractionUsd: args.preferences.providerLimitsUsd[args.provider],
  };
}

function resolveProviderLimit(
  provider: BudgetProviderId,
  overrides: ProviderBudgetLimitOverridesUsd | undefined,
): number {
  const configured = overrides?.[provider];
  return configured !== undefined && isValidProviderBudgetLimitUsd(configured)
    ? configured
    : DEFAULT_PROVIDER_BUDGET_LIMITS_USD[provider];
}
