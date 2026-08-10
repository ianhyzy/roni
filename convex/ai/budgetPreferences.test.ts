import { describe, expect, it } from "vitest";
import {
  isValidProviderBudgetLimitUsd,
  resolveAiBudgetPolicy,
  resolveAiBudgetPreferences,
} from "../../lib/aiBudgetPreferences";

describe("resolveAiBudgetPreferences", () => {
  it("uses the provider defaults when preferences are absent", () => {
    expect(resolveAiBudgetPreferences()).toEqual({
      ignoreBudget: false,
      providerLimitsUsd: {
        gemini: 25,
        claude: 101,
        openai: 200,
        openrouter: 200,
      },
    });
  });

  it("overrides only the configured provider", () => {
    const preferences = resolveAiBudgetPreferences({
      providerLimitOverridesUsd: { claude: 0.75 },
    });

    expect(preferences.providerLimitsUsd).toEqual({
      gemini: 25,
      claude: 0.75,
      openai: 200,
      openrouter: 200,
    });
  });

  it("falls back when persisted limits are invalid", () => {
    const preferences = resolveAiBudgetPreferences({
      providerLimitOverridesUsd: { gemini: 0, openai: Number.POSITIVE_INFINITY },
    });

    expect(preferences.providerLimitsUsd.gemini).toBe(25);
    expect(preferences.providerLimitsUsd.openai).toBe(200);
  });
});

describe("resolveAiBudgetPolicy", () => {
  it("uses the selected provider limit for a personal key", () => {
    const preferences = resolveAiBudgetPreferences({
      providerLimitOverridesUsd: { openrouter: 1.25 },
    });

    expect(
      resolveAiBudgetPolicy({ isHouseKey: false, provider: "openrouter", preferences }),
    ).toEqual({ kind: "limit", maxAttemptUsd: 1.25 });
  });

  it("disables the guard for every personal provider when the global preference is on", () => {
    const preferences = resolveAiBudgetPreferences({
      ignoreBudget: true,
      providerLimitOverridesUsd: { openai: 0.5 },
    });

    for (const provider of ["gemini", "claude", "openai", "openrouter"] as const) {
      expect(resolveAiBudgetPolicy({ isHouseKey: false, provider, preferences })).toEqual({
        kind: "disabled",
      });
    }
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
    [400, true],
    [400.01, false],
    [0, false],
    [-1, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
  ])("validates %s as %s", (value, expected) => {
    expect(isValidProviderBudgetLimitUsd(value)).toBe(expected);
  });
});
