import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_BUDGET_LIMITS_USD,
  isValidProviderBudgetLimitUsd,
  resolveAiBudgetPolicy,
  resolveAiBudgetPreferences,
} from "../../lib/aiBudgetPreferences";

describe("resolveAiBudgetPreferences", () => {
  it("uses the provider defaults when preferences are absent", () => {
    expect(resolveAiBudgetPreferences()).toEqual({
      ignoreBudget: false,
      providerLimitsUsd: DEFAULT_PROVIDER_BUDGET_LIMITS_USD,
    });
  });

  it("overrides only the configured provider", () => {
    const preferences = resolveAiBudgetPreferences({
      providerLimitOverridesUsd: { claude: 0.75 },
    });

    expect(preferences.providerLimitsUsd).toEqual({
      ...DEFAULT_PROVIDER_BUDGET_LIMITS_USD,
      claude: 0.75,
    });
  });

  it("falls back when persisted limits are invalid", () => {
    const preferences = resolveAiBudgetPreferences({
      providerLimitOverridesUsd: { gemini: 0, openai: Number.POSITIVE_INFINITY },
    });

    expect(preferences.providerLimitsUsd.gemini).toBe(DEFAULT_PROVIDER_BUDGET_LIMITS_USD.gemini);
    expect(preferences.providerLimitsUsd.openai).toBe(DEFAULT_PROVIDER_BUDGET_LIMITS_USD.openai);
  });
});

describe("resolveAiBudgetPolicy", () => {
  it("uses the selected provider limit for a personal key", () => {
    const preferences = resolveAiBudgetPreferences({
      providerLimitOverridesUsd: { openrouter: 1.25 },
    });

    expect(
      resolveAiBudgetPolicy({ isHouseKey: false, provider: "openrouter", preferences }),
    ).toEqual({ kind: "limit", maxInteractionUsd: 1.25 });
  });

  it("disables the guard when the user ignores the budget", () => {
    const preferences = resolveAiBudgetPreferences({
      ignoreBudget: true,
      providerLimitOverridesUsd: { openai: 0.5 },
    });

    expect(resolveAiBudgetPolicy({ isHouseKey: false, provider: "openai", preferences })).toEqual({
      kind: "disabled",
    });
    expect(preferences.providerLimitsUsd.openai).toBe(0.5);
  });

  it("disables the personal-key guard for the shared house key", () => {
    const preferences = resolveAiBudgetPreferences();

    expect(resolveAiBudgetPolicy({ isHouseKey: true, provider: "gemini", preferences })).toEqual({
      kind: "disabled",
    });
  });
});

describe("isValidProviderBudgetLimitUsd", () => {
  it.each([
    [0.01, true],
    [0, false],
    [-1, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
  ])("validates %s as %s", (value, expected) => {
    expect(isValidProviderBudgetLimitUsd(value)).toBe(expected);
  });
});
