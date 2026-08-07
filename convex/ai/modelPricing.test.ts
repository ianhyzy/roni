import { describe, expect, it } from "vitest";
import { getConservativeModelPricing, getModelPricing } from "./modelPricing";
import { getModelForTier, MODEL_TIERS, type ProviderId, PROVIDERS } from "./providers";

describe("getModelPricing", () => {
  it("prices all default policy tiers", () => {
    for (const provider of Object.keys(PROVIDERS) as ProviderId[]) {
      for (const tier of MODEL_TIERS) {
        const modelId = getModelForTier(provider, tier);
        expect(getModelPricing(provider, modelId), `${provider}.${tier}`).toBeDefined();
      }
    }
  });

  it("accepts legitimate OpenRouter vendor and automatic model ids", () => {
    expect(getModelPricing("openrouter", "openai/gpt-5.4-nano")?.inputUsdPerMillion).toBe(0.2);
    expect(getModelPricing("openrouter", "google/gemini-2.5-flash-lite")?.outputUsdPerMillion).toBe(
      0.4,
    );
    expect(getModelPricing("openrouter", "auto")).toEqual(
      getModelPricing("openrouter", "openrouter/auto"),
    );
  });

  it.each([
    ["openrouter", "attacker/gpt-5.4-nano"],
    ["openrouter", "gpt-5.4-nano"],
    ["openrouter", "openai/gpt-5.4-nano-premium"],
    ["gemini", "gpt-5.4-nano"],
    ["gemini", "openai/gpt-5.4-nano"],
    ["openai", "anthropic/claude-haiku-4-5"],
    ["claude", "google/gemini-3.6-flash"],
  ] as const)("rejects %s pricing for mismatched model %s", (provider, modelId) => {
    expect(getModelPricing(provider, modelId)).toBeUndefined();
  });

  it.each([
    ["gemini", "gemini-3.5-flash-lite", 0.3, 0.03, 0.03, 2.5],
    ["gemini", "gemini-3.6-flash", 1.5, 0.15, 0.15, 7.5],
    ["claude", "claude-sonnet-5", 3, 0.3, 3.75, 15],
    ["claude", "claude-opus-5", 5, 0.5, 6.25, 25],
    ["openai", "gpt-5.6-luna", 1, 0.1, 1.25, 6],
    ["openai", "gpt-5.6-terra", 2.5, 0.25, 3.125, 15],
    ["openai", "gpt-5.6-sol", 5, 0.5, 6.25, 30],
  ] as const)(
    "prices current %s model %s",
    (provider, modelId, input, cacheRead, cacheWrite, output) => {
      expect(getModelPricing(provider, modelId)).toEqual({
        inputUsdPerMillion: input,
        cacheReadUsdPerMillion: cacheRead,
        cacheWriteUsdPerMillion: cacheWrite,
        outputUsdPerMillion: output,
      });
    },
  );

  it("prices dated provider model variants by family", () => {
    expect(getModelPricing("claude", "anthropic/claude-sonnet-5-20260715")).toEqual(
      getModelPricing("claude", "claude-sonnet-5"),
    );
    expect(getModelPricing("openrouter", "openai/gpt-5.6-terra-20260715")).toEqual(
      getModelPricing("openai", "gpt-5.6-terra"),
    );
    expect(getModelPricing("claude", "anthropic/claude-sonnet-4-6-20250514")).toEqual(
      getModelPricing("claude", "claude-sonnet-4-6"),
    );
    expect(getModelPricing("openrouter", "openai/gpt-5.4-mini-20260501")).toEqual(
      getModelPricing("openai", "gpt-5.4-mini"),
    );
  });

  it("uses the high Gemini Pro prompt tier for enforcement pricing", () => {
    expect(getModelPricing("gemini", "gemini-2.5-pro")).toEqual({
      inputUsdPerMillion: 2.5,
      cacheReadUsdPerMillion: 0.25,
      cacheWriteUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
    });
  });

  it("uses component-wise maxima across each provider's production tiers", () => {
    expect(getConservativeModelPricing("gemini")).toEqual({
      inputUsdPerMillion: 1.5,
      cacheReadUsdPerMillion: 0.15,
      cacheWriteUsdPerMillion: 0.15,
      outputUsdPerMillion: 7.5,
    });
    expect(getConservativeModelPricing("claude")).toEqual({
      inputUsdPerMillion: 5,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      outputUsdPerMillion: 25,
    });
    expect(getConservativeModelPricing("openai")).toEqual({
      inputUsdPerMillion: 5,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      outputUsdPerMillion: 30,
    });
  });

  it("uses the component-wise maximum known rate for unknown OpenRouter models", () => {
    expect(getConservativeModelPricing("openrouter")).toEqual({
      inputUsdPerMillion: 5,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      outputUsdPerMillion: 30,
    });
  });
});
