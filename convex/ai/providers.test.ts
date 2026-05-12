import { describe, expect, it } from "vitest";
import {
  assertNoPreviewDefaults,
  getFallbackTier,
  getModelForTier,
  getModelPricing,
  getPromptInputBudget,
  getProviderConfig,
  isValidProvider,
  MODEL_TIERS,
  PROMPT_OUTPUT_HEADROOM_RATIO,
  type ProviderId,
  PROVIDERS,
  validateKeyFormat,
} from "./providers";

describe("PROVIDERS registry", () => {
  it("contains all four providers", () => {
    const ids = Object.keys(PROVIDERS);
    expect(ids).toContain("gemini");
    expect(ids).toContain("claude");
    expect(ids).toContain("openai");
    expect(ids).toContain("openrouter");
    expect(ids).toHaveLength(4);
  });

  it("each provider has required fields", () => {
    for (const [id, config] of Object.entries(PROVIDERS)) {
      expect(config.label, `${id}.label`).toBeTruthy();
      expect(config.keyRegex, `${id}.keyRegex`).toBeInstanceOf(RegExp);
      expect(config.keyFormatError, `${id}.keyFormatError`).toBeTruthy();
      expect(config.keySourceUrl, `${id}.keySourceUrl`).toBeTruthy();
      expect(config.keyPlaceholder, `${id}.keyPlaceholder`).toBeTruthy();
      expect(Object.keys(config.modelPolicy).sort(), `${id}.modelPolicy`).toEqual(
        [...MODEL_TIERS].sort(),
      );
    }
  });

  it("does not use preview/latest/experimental model ids in defaults", () => {
    expect(() => assertNoPreviewDefaults()).not.toThrow();
  });
});

describe("validateKeyFormat", () => {
  it("accepts valid Gemini key", () => {
    expect(validateKeyFormat("gemini", "AIzaSyA1234567890abcdefghijklmnopqrstuv")).toBe(true);
  });

  it("rejects invalid Gemini key", () => {
    expect(validateKeyFormat("gemini", "sk-ant-bad")).toBe(false);
  });

  it("accepts valid Claude key", () => {
    expect(validateKeyFormat("claude", "sk-ant-api03-abc123")).toBe(true);
  });

  it("accepts valid OpenAI key", () => {
    expect(validateKeyFormat("openai", "sk-proj-abc123")).toBe(true);
  });

  it("rejects Claude key as OpenAI", () => {
    expect(validateKeyFormat("openai", "sk-ant-api03-abc123")).toBe(false);
  });

  it("rejects OpenRouter key as OpenAI", () => {
    expect(validateKeyFormat("openai", "sk-or-v1-abc123")).toBe(false);
  });

  it("accepts valid OpenRouter key", () => {
    expect(validateKeyFormat("openrouter", "sk-or-v1-abc123")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(validateKeyFormat("gemini", "")).toBe(false);
  });
});

describe("getProviderConfig", () => {
  it("returns config for valid provider", () => {
    const config = getProviderConfig("gemini");
    expect(config.label).toBe("Google Gemini");
  });

  it("uses chat/router compatibility aliases from the tier policy", () => {
    expect(getProviderConfig("gemini").primaryModel).toBe("gemini-2.5-flash");
    expect(getProviderConfig("gemini").fallbackModel).toBe("gemini-2.5-flash-lite");
    expect(getProviderConfig("claude").primaryModel).toBe("claude-sonnet-4-6");
    expect(getProviderConfig("claude").fallbackModel).toBe("claude-haiku-4-5");
    expect(getProviderConfig("openai").primaryModel).toBe("gpt-5.4-mini");
    expect(getProviderConfig("openai").fallbackModel).toBe("gpt-5.4-nano");
    expect(getProviderConfig("openrouter").primaryModel).toBe("openrouter/auto");
    expect(getProviderConfig("openrouter").fallbackModel).toBeNull();
  });

  it("resolves explicit tier models", () => {
    expect(getModelForTier("gemini", "router")).toBe("gemini-2.5-flash-lite");
    expect(getModelForTier("gemini", "chat")).toBe("gemini-2.5-flash");
    expect(getModelForTier("gemini", "programming")).toBe("gemini-2.5-flash");
    expect(getModelForTier("gemini", "summarize")).toBe("gemini-2.5-flash-lite");
    expect(getModelForTier("claude", "programming")).toBe("claude-opus-4-7");
    expect(getModelForTier("openai", "router")).toBe("gpt-5.4-nano");
    expect(getModelForTier("openrouter", "programming", "anthropic/claude-sonnet-4.6")).toBe(
      "anthropic/claude-sonnet-4.6",
    );
  });

  it("uses deterministic fallback tiers", () => {
    expect(getFallbackTier("router")).toBe("chat");
    expect(getFallbackTier("chat")).toBe("router");
    expect(getFallbackTier("programming")).toBe("chat");
    expect(getFallbackTier("summarize")).toBe("router");
  });

  it("throws for invalid provider", () => {
    expect(() => getProviderConfig("invalid" as ProviderId)).toThrow();
  });
});

describe("isValidProvider", () => {
  it("returns true for valid providers", () => {
    expect(isValidProvider("gemini")).toBe(true);
    expect(isValidProvider("claude")).toBe(true);
    expect(isValidProvider("openai")).toBe(true);
    expect(isValidProvider("openrouter")).toBe(true);
  });

  it("returns false for invalid providers", () => {
    expect(isValidProvider("gpt")).toBe(false);
    expect(isValidProvider("")).toBe(false);
  });
});

describe("getPromptInputBudget", () => {
  it("uses conservative high-capacity budgets for Gemini and OpenAI defaults", () => {
    expect(getPromptInputBudget("gemini", "gemini-2.5-pro")).toBe(500_000);
    expect(getPromptInputBudget("gemini", "gemini-2.5-flash")).toBe(500_000);
    expect(getPromptInputBudget("gemini", "gemini-2.5-flash-lite")).toBe(500_000);
    expect(getPromptInputBudget("openai", "gpt-5.4")).toBe(500_000);
    expect(getPromptInputBudget("openai", "gpt-5.4-mini")).toBe(500_000);
    expect(getPromptInputBudget("openai", "gpt-5.4-nano")).toBe(500_000);
  });

  it("uses high-capacity Claude budgets for Sonnet and Opus", () => {
    expect(getPromptInputBudget("claude", "claude-sonnet-4-6")).toBe(500_000);
    expect(getPromptInputBudget("claude", "claude-opus-4-7")).toBe(500_000);
  });

  it("uses the small fallback budget for Haiku, OpenRouter, and unknown models", () => {
    expect(getPromptInputBudget("claude", "claude-haiku-4-5")).toBe(50_000);
    expect(getPromptInputBudget("openrouter", "openrouter/auto")).toBe(50_000);
    expect(getPromptInputBudget("gemini", "mystery-model")).toBe(50_000);
  });

  it("normalizes provider-prefixed, cased, and padded model IDs", () => {
    expect(getPromptInputBudget("gemini", "google/gemini-2.5-flash")).toBe(500_000);
    expect(getPromptInputBudget("claude", "anthropic/claude-sonnet-4-6")).toBe(500_000);
    expect(getPromptInputBudget("openai", " OpenAI/GPT-5.4-mini ")).toBe(500_000);
  });

  it("reserves twenty percent output headroom", () => {
    expect(PROMPT_OUTPUT_HEADROOM_RATIO).toBe(0.2);
  });
});

describe("getModelPricing", () => {
  it("prices all default policy tiers", () => {
    for (const provider of Object.keys(PROVIDERS) as ProviderId[]) {
      for (const tier of MODEL_TIERS) {
        const modelId = getModelForTier(provider, tier);
        expect(getModelPricing(provider, modelId), `${provider}.${tier}`).toBeDefined();
      }
    }
  });

  it("normalizes provider-prefixed model ids", () => {
    expect(getModelPricing("openrouter", "openai/gpt-5.4-nano")?.inputUsdPerMillion).toBe(0.2);
    expect(getModelPricing("openrouter", "google/gemini-2.5-flash-lite")?.outputUsdPerMillion).toBe(
      0.4,
    );
  });

  it("prices dated provider model variants by family", () => {
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
});
