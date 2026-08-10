import { describe, expect, it } from "vitest";
import { estimateAttemptCostUsd } from "./circuitBreakerCore";

describe("estimateAttemptCostUsd", () => {
  it("prices GPT-5.4 mini using cached-input discounts", () => {
    const cost = estimateAttemptCostUsd({
      provider: "openai",
      model: "gpt-5.4-mini",
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 0,
    });

    expect(cost).toBeCloseTo(0.1065, 4);
  });

  it("normalizes provider-prefixed Gemini model ids", () => {
    const cost = estimateAttemptCostUsd({
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      inputTokens: 200_000,
      outputTokens: 25_000,
      cacheReadTokens: 50_000,
      cacheWriteTokens: 0,
    });

    expect(cost).toBeCloseTo(0.109, 4);
  });

  it("uses conservative pricing for unknown OpenRouter override models", () => {
    const cost = estimateAttemptCostUsd({
      provider: "openrouter",
      model: "google/gemini-3-flash-preview",
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(cost).toBeCloseTo(0.035, 6);
  });

  it("does not trust a known model family behind an unknown OpenRouter vendor", () => {
    const cost = estimateAttemptCostUsd({
      provider: "openrouter",
      model: "attacker/gpt-5.4-nano",
      inputTokens: 1_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    expect(cost).toBeCloseTo(0.035, 6);
  });

  it.each([
    ["gpt-5.4", "openai", 5, 22.5],
    ["gpt-5.6-luna", "openai", 0.5, 1.8],
    ["gpt-5.6-terra", "openai", 5, 18],
    ["gpt-5.6-sol", "openai", 12.5, 45],
    ["openai/gpt-5.6-terra", "openrouter", 5, 18],
  ] as const)(
    "prices long-context %s requests through %s",
    (model, provider, cacheWriteRate, outputRate) => {
      const cost = estimateAttemptCostUsd({
        provider,
        model,
        inputTokens: 300_000,
        outputTokens: 10_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 300_000,
      });

      expect(cost).toBeCloseTo((300_000 * cacheWriteRate + 10_000 * outputRate) / 1_000_000, 6);
    },
  );

  it.each(["openrouter/auto", "attacker/unknown-model"])(
    "uses long-context conservative pricing for OpenRouter model %s",
    (model) => {
      const cost = estimateAttemptCostUsd({
        provider: "openrouter",
        model,
        inputTokens: 300_000,
        outputTokens: 10_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 300_000,
      });

      expect(cost).toBeCloseTo(4.2, 6);
    },
  );

  it.each([
    ["google.generative-ai", "gemini-3.6-flash", 0.12],
    ["anthropic.messages", "claude-opus-5", 2.125],
    ["openai.responses", "gpt-5.6-sol", 4.2],
    ["openai.chat", "openrouter/auto", 4.2],
  ] as const)("maps runtime provider %s before pricing %s", (provider, model, expected) => {
    const cost = estimateAttemptCostUsd({
      provider,
      model,
      inputTokens: 300_000,
      outputTokens: 10_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 300_000,
    });

    expect(cost).toBeCloseTo(expected, 6);
  });
});
