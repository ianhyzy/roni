import { describe, expect, it } from "vitest";
import {
  aggregateCacheHitsByProviderAndModel,
  BUDGET_WARNING_THRESHOLD,
  calculateWeightedUsageTokens,
  DAILY_TOKEN_BUDGET,
} from "./aiUsage";

describe("AI usage constants", () => {
  it("DAILY_TOKEN_BUDGET is 500k", () => {
    expect(DAILY_TOKEN_BUDGET).toBe(500_000);
  });

  it("BUDGET_WARNING_THRESHOLD is 80%", () => {
    expect(BUDGET_WARNING_THRESHOLD).toBe(0.8);
  });

  it("warning threshold is less than budget", () => {
    expect(DAILY_TOKEN_BUDGET * BUDGET_WARNING_THRESHOLD).toBeLessThan(DAILY_TOKEN_BUDGET);
  });
});

describe("aggregateCacheHitsByProviderAndModel", () => {
  it("groups rows by provider and computes cache read ratio", () => {
    const result = aggregateCacheHitsByProviderAndModel([
      {
        provider: "gemini",
        model: "gemini-2.5-flash",
        inputTokens: 10_000,
        cacheReadTokens: 8_000,
        cacheWriteTokens: 0,
      },
      {
        provider: "gemini",
        model: "gemini-2.5-flash",
        inputTokens: 5_000,
        cacheReadTokens: 1_000,
        cacheWriteTokens: 0,
      },
      {
        provider: "claude",
        model: "claude-sonnet-4-6",
        inputTokens: 8_000,
        cacheReadTokens: 6_000,
        cacheWriteTokens: 500,
      },
    ]);

    const gemini = result.find((r) => r.model === "gemini-2.5-flash");
    expect(gemini).toMatchObject({
      provider: "gemini",
      model: "gemini-2.5-flash",
      rows: 2,
      inputTokens: 15_000,
      cacheReadTokens: 9_000,
    });
    expect(gemini!.cacheReadRatio).toBeCloseTo(9_000 / 15_000);

    const claude = result.find((r) => r.model === "claude-sonnet-4-6");
    expect(claude).toMatchObject({
      rows: 1,
      inputTokens: 8_000,
      cacheReadTokens: 6_000,
      cacheWriteTokens: 500,
    });
  });

  it("skips rows with zero input tokens (routing entries)", () => {
    const result = aggregateCacheHitsByProviderAndModel([
      { provider: "local", model: "keyword-classifier", inputTokens: 0 },
      { provider: "gemini", model: "gemini-2.5-flash", inputTokens: 1_000, cacheReadTokens: 500 },
    ]);

    expect(result.map((r) => r.provider)).toEqual(["gemini"]);
  });

  it("returns providers sorted by input token volume descending", () => {
    const result = aggregateCacheHitsByProviderAndModel([
      { provider: "openai", model: "gpt-5-mini", inputTokens: 1_000 },
      { provider: "gemini", model: "gemini-2.5-flash", inputTokens: 100_000 },
      { provider: "claude", model: "claude-sonnet-4-6", inputTokens: 20_000 },
    ]);

    expect(result.map((r) => r.provider)).toEqual(["gemini", "claude", "openai"]);
  });

  it("defaults missing cache fields to zero without NaN ratios", () => {
    const result = aggregateCacheHitsByProviderAndModel([
      { provider: "openai", model: "gpt-5-mini", inputTokens: 2_000 },
    ]);

    expect(result[0]).toMatchObject({
      provider: "openai",
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheReadRatio: 0,
    });
  });

  it("keeps models separate within the same provider", () => {
    const result = aggregateCacheHitsByProviderAndModel([
      { provider: "gemini", model: "gemini-2.5-flash", inputTokens: 1_000 },
      { provider: "gemini", model: "gemini-3-flash", inputTokens: 2_000 },
    ]);

    expect(result.map((row) => row.model)).toEqual(["gemini-3-flash", "gemini-2.5-flash"]);
  });

  it("skips embedding and non-finite model-call rows", () => {
    const result = aggregateCacheHitsByProviderAndModel([
      { provider: "gemini", model: "gemini-embedding-001", inputTokens: 5_000 },
      { provider: "gemini", model: "gemini-2.5-flash", inputTokens: Number.POSITIVE_INFINITY },
      { provider: "gemini", model: "gemini-2.5-flash", inputTokens: 1_000 },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ model: "gemini-2.5-flash", inputTokens: 1_000 });
  });

  it("normalizes invalid cache fields and caps them at input tokens", () => {
    const result = aggregateCacheHitsByProviderAndModel([
      {
        provider: "gemini",
        model: "gemini-2.5-flash",
        inputTokens: 1_000,
        cacheReadTokens: Number.NaN,
        cacheWriteTokens: -10,
      },
      {
        provider: "gemini",
        model: "gemini-2.5-flash",
        inputTokens: 2_000,
        cacheReadTokens: 5_000,
        cacheWriteTokens: Number.POSITIVE_INFINITY,
      },
    ]);

    expect(result[0]).toMatchObject({
      inputTokens: 3_000,
      cacheReadTokens: 2_000,
      cacheWriteTokens: 0,
    });
    expect(result[0]!.cacheReadRatio).toBeCloseTo(2 / 3);
  });
});

describe("calculateWeightedUsageTokens", () => {
  it("applies Claude cache and output multipliers", () => {
    expect(
      calculateWeightedUsageTokens({
        provider: "claude",
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 600,
        cacheWriteTokens: 100,
      }),
    ).toBe(1_485);
  });

  it("falls back to stored totalTokens for historical rows without cache fields", () => {
    expect(
      calculateWeightedUsageTokens({
        provider: "claude",
        inputTokens: 800,
        outputTokens: 200,
        totalTokens: 1_000,
      }),
    ).toBe(1_000);
  });
});
