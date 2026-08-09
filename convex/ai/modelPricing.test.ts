import { describe, expect, it } from "vitest";
import {
  getConservativeModelPricing,
  getEffectiveModelPricing,
  getModelPricing,
  OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS,
} from "./modelPricing";
import { getModelForTier, MODEL_TIERS, PROVIDER_IDS } from "./providers";

describe("getModelPricing", () => {
  it("defines pricing for every default provider tier", () => {
    for (const provider of PROVIDER_IDS) {
      for (const tier of MODEL_TIERS) {
        const modelId = getModelForTier(provider, tier);
        const pricing = getModelPricing(provider, modelId);

        expect(pricing, `${provider}.${tier}`).toBeDefined();
      }
    }
  });

  it("accepts legitimate OpenRouter vendor and automatic model ids", () => {
    const openAiPricing = getModelPricing("openrouter", "openai/gpt-5.4-nano");
    const googlePricing = getModelPricing("openrouter", "google/gemini-2.5-flash-lite");
    const automaticPricing = getModelPricing("openrouter", "auto");

    expect(openAiPricing?.inputUsdPerMillion).toBe(0.2);
    expect(googlePricing?.outputUsdPerMillion).toBe(0.4);
    expect(automaticPricing).toEqual(getModelPricing("openrouter", "openrouter/auto"));
  });

  it.each([
    ["openrouter", "attacker/gpt-5.4-nano"],
    ["openrouter", "constructor/gpt-5.4-nano"],
    ["openrouter", "__proto__/gpt-5.4-nano"],
    ["openrouter", "gpt-5.4-nano"],
    ["openrouter", "openai/gpt-5.4-nano-premium"],
    ["gemini", "gpt-5.4-nano"],
    ["gemini", "openai/gpt-5.4-nano"],
    ["openai", "anthropic/claude-haiku-4-5"],
    ["claude", "google/gemini-3.6-flash"],
  ] as const)("returns no %s pricing for mismatched model %s", (provider, modelId) => {
    const pricing = getModelPricing(provider, modelId);

    expect(pricing).toBeUndefined();
  });

  it.each([
    ["gemini", "gemini-3.5-flash-lite", 0.3, 0.03, 0.03, 2.5],
    ["gemini", "gemini-3.6-flash", 1.5, 0.15, 0.15, 7.5],
    ["claude", "claude-sonnet-5", 3, 0.3, 3.75, 15],
    ["claude", "claude-opus-5", 5, 0.5, 6.25, 25],
    ["openai", "gpt-5.6-luna", 0.2, 0.02, 0.25, 1.2],
    ["openai", "gpt-5.6-terra", 2, 0.2, 2.5, 12],
    ["openai", "gpt-5.6-sol", 5, 0.5, 6.25, 30],
  ] as const)(
    "returns current %s rates for model %s",
    (provider, modelId, input, cacheRead, cacheWrite, output) => {
      const pricing = getModelPricing(provider, modelId);

      expect(pricing).toEqual({
        inputUsdPerMillion: input,
        cacheReadUsdPerMillion: cacheRead,
        cacheWriteUsdPerMillion: cacheWrite,
        outputUsdPerMillion: output,
      });
    },
  );

  it("matches dated provider model variants to their model families", () => {
    const sonnetPricing = getModelPricing("claude", "anthropic/claude-sonnet-5-20260715");
    const terraPricing = getModelPricing("openrouter", "openai/gpt-5.6-terra-20260715");
    const legacySonnetPricing = getModelPricing("claude", "anthropic/claude-sonnet-4-6-20250514");
    const miniPricing = getModelPricing("openrouter", "openai/gpt-5.4-mini-20260501");
    const openAiSnapshotPricing = getModelPricing("openai", "gpt-5.4-2026-03-05");

    expect(sonnetPricing).toEqual(getModelPricing("claude", "claude-sonnet-5"));
    expect(terraPricing).toEqual(getModelPricing("openai", "gpt-5.6-terra"));
    expect(legacySonnetPricing).toEqual(getModelPricing("claude", "claude-sonnet-4-6"));
    expect(miniPricing).toEqual(getModelPricing("openai", "gpt-5.4-mini"));
    expect(openAiSnapshotPricing).toEqual(getModelPricing("openai", "gpt-5.4"));
  });

  it("uses the high Gemini Pro prompt tier for enforcement pricing", () => {
    const pricing = getModelPricing("gemini", "gemini-2.5-pro");

    expect(pricing).toEqual({
      inputUsdPerMillion: 2.5,
      cacheReadUsdPerMillion: 0.25,
      cacheWriteUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
    });
  });
});

describe("getEffectiveModelPricing", () => {
  it.each([
    ["gpt-5.4", [2.5, 0.25, 2.5, 15], [5, 0.5, 5, 22.5]],
    ["gpt-5.6-luna", [0.2, 0.02, 0.25, 1.2], [0.4, 0.04, 0.5, 1.8]],
    ["gpt-5.6-terra", [2, 0.2, 2.5, 12], [4, 0.4, 5, 18]],
    ["gpt-5.6-sol", [5, 0.5, 6.25, 30], [10, 1, 12.5, 45]],
  ] as const)(
    "applies long-context rates to %s only above the input threshold",
    (modelId, baseRates, longContextRates) => {
      const expectedBase = {
        inputUsdPerMillion: baseRates[0],
        cacheReadUsdPerMillion: baseRates[1],
        cacheWriteUsdPerMillion: baseRates[2],
        outputUsdPerMillion: baseRates[3],
      };
      const atThreshold = getEffectiveModelPricing({
        provider: "openai",
        modelId,
        inputTokens: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS,
      });
      const aboveThreshold = getEffectiveModelPricing({
        provider: "openai",
        modelId,
        inputTokens: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS + 1,
      });

      expect(atThreshold).toEqual(expectedBase);
      expect(aboveThreshold.inputUsdPerMillion).toBeCloseTo(longContextRates[0], 10);
      expect(aboveThreshold.cacheReadUsdPerMillion).toBeCloseTo(longContextRates[1], 10);
      expect(aboveThreshold.cacheWriteUsdPerMillion).toBeCloseTo(longContextRates[2], 10);
      expect(aboveThreshold.outputUsdPerMillion).toBeCloseTo(longContextRates[3], 10);
    },
  );

  it.each([
    ["openai", "gpt-5.4-mini"],
    ["openai", "gpt-5.4-nano"],
    ["openrouter", "openai/gpt-5.4-mini"],
    ["openrouter", "openai/gpt-5.4-nano"],
  ] as const)(
    "keeps %s model %s at base rates above the long-context threshold",
    (provider, modelId) => {
      const pricing = getEffectiveModelPricing({
        provider,
        modelId,
        inputTokens: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS + 1,
      });

      expect(pricing).toEqual(getModelPricing(provider, modelId));
    },
  );

  it("applies long-context rates to an explicit OpenAI model through OpenRouter", () => {
    const pricing = getEffectiveModelPricing({
      provider: "openrouter",
      modelId: "openai/gpt-5.6-terra",
      inputTokens: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS + 1,
    });

    expect(pricing).toEqual({
      inputUsdPerMillion: 4,
      cacheReadUsdPerMillion: 0.4,
      cacheWriteUsdPerMillion: 5,
      outputUsdPerMillion: 18,
    });
  });

  it("applies long-context rates to hyphenated OpenAI model snapshots", () => {
    const pricing = getEffectiveModelPricing({
      provider: "openai",
      modelId: "gpt-5.4-2026-03-05",
      inputTokens: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS + 1,
    });

    expect(pricing).toEqual({
      inputUsdPerMillion: 5,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 5,
      outputUsdPerMillion: 22.5,
    });
  });

  it.each(["openrouter/auto", "attacker/unknown-model", undefined])(
    "uses conservative long-context rates for OpenRouter model %s",
    (modelId) => {
      const pricing = getEffectiveModelPricing({
        provider: "openrouter",
        modelId,
        inputTokens: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS + 1,
      });

      expect(pricing).toEqual({
        inputUsdPerMillion: 10,
        cacheReadUsdPerMillion: 1,
        cacheWriteUsdPerMillion: 12.5,
        outputUsdPerMillion: 45,
      });
    },
  );

  it("uses conservative rates for OpenRouter auto at the exact threshold", () => {
    const pricing = getEffectiveModelPricing({
      provider: "openrouter",
      modelId: "openrouter/auto",
      inputTokens: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS,
    });

    expect(pricing).toEqual({
      inputUsdPerMillion: 5,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      outputUsdPerMillion: 30,
    });
  });

  it("uses conservative long-context rates for an unknown direct OpenAI model", () => {
    const pricing = getEffectiveModelPricing({
      provider: "openai",
      modelId: "future-model",
      inputTokens: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS + 1,
    });

    expect(pricing).toEqual({
      inputUsdPerMillion: 10,
      cacheReadUsdPerMillion: 1,
      cacheWriteUsdPerMillion: 12.5,
      outputUsdPerMillion: 45,
    });
  });

  it.each([
    ["openrouter", "google/gemini-3.6-flash"],
    ["openrouter", "anthropic/claude-opus-5"],
    ["gemini", "gemini-3.6-flash"],
    ["claude", "claude-opus-5"],
  ] as const)("keeps known non-OpenAI %s model %s at base rates", (provider, modelId) => {
    const pricing = getEffectiveModelPricing({
      provider,
      modelId,
      inputTokens: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD_TOKENS + 1,
    });

    expect(pricing).toEqual(getModelPricing(provider, modelId));
  });
});

describe("getConservativeModelPricing", () => {
  it("uses component-wise maxima across each provider's production tiers", () => {
    const geminiPricing = getConservativeModelPricing("gemini");
    const claudePricing = getConservativeModelPricing("claude");
    const openAiPricing = getConservativeModelPricing("openai");

    expect(geminiPricing).toEqual({
      inputUsdPerMillion: 1.5,
      cacheReadUsdPerMillion: 0.15,
      cacheWriteUsdPerMillion: 0.15,
      outputUsdPerMillion: 7.5,
    });
    expect(claudePricing).toEqual({
      inputUsdPerMillion: 5,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      outputUsdPerMillion: 25,
    });
    expect(openAiPricing).toEqual({
      inputUsdPerMillion: 5,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      outputUsdPerMillion: 30,
    });
  });

  it("uses the component-wise maximum known rate for unknown OpenRouter models", () => {
    const pricing = getConservativeModelPricing("openrouter");

    expect(pricing).toEqual({
      inputUsdPerMillion: 5,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      outputUsdPerMillion: 30,
    });
  });
});
