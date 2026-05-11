import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import {
  buildCoachAgentsForProvider,
  createModelTierPrepareStep,
  selectCoachPrepareStepTier,
} from "./coach";
import { MODEL_TIERS, type ModelTier } from "./providers";

describe("coach agent model tiers", () => {
  it("builds Gemini tier metadata without preview defaults", () => {
    const agents = buildCoachAgentsForProvider({
      provider: "gemini",
      apiKey: "test-gemini-key",
    });

    expect(agents.tierModelNames).toEqual({
      router: "gemini-2.5-flash-lite",
      chat: "gemini-2.5-flash",
      programming: "gemini-2.5-pro",
      summarize: "gemini-2.5-flash-lite",
    });
    expect(
      Object.values(agents.tierModelNames).every((modelId) => !modelId.includes("preview")),
    ).toBe(true);
  });

  it("applies an OpenRouter model override to every tier", () => {
    const agents = buildCoachAgentsForProvider({
      provider: "openrouter",
      apiKey: "sk-or-v1-test",
      modelOverride: "anthropic/claude-sonnet-4.6",
    });

    expect(agents.tierModelNames).toEqual({
      router: "anthropic/claude-sonnet-4.6",
      chat: "anthropic/claude-sonnet-4.6",
      programming: "anthropic/claude-sonnet-4.6",
      summarize: "anthropic/claude-sonnet-4.6",
    });
  });

  it("keeps programming and router requests on their initial prepareStep tier", () => {
    expect(selectCoachPrepareStepTier("programming", [])).toBe("programming");
    expect(
      selectCoachPrepareStepTier("router", [{ toolCalls: [{ toolName: "program_week" }] }]),
    ).toBe("router");
  });

  it("escalates a chat prepareStep after programming tool calls", () => {
    expect(
      selectCoachPrepareStepTier("chat", [{ toolCalls: [{ toolName: "program_week" }] }]),
    ).toBe("programming");
  });

  it("returns the selected tier model from prepareStep", () => {
    const tierModels = Object.fromEntries(
      MODEL_TIERS.map((tier) => [tier, { modelId: `${tier}-model` }]),
    ) as Record<ModelTier, LanguageModel>;
    const prepareStep = createModelTierPrepareStep({ initialTier: "chat", tierModels });

    const result = prepareStep({
      steps: [{ toolCalls: [{ toolName: "program_week" }] }],
      stepNumber: 1,
      model: tierModels.chat,
      messages: [],
      experimental_context: undefined,
    } as Parameters<typeof prepareStep>[0]);

    expect(result).toEqual({ model: tierModels.programming });
  });

  it("keeps fallback prepareStep on the fixed fallback tier", () => {
    const tierModels = Object.fromEntries(
      MODEL_TIERS.map((tier) => [tier, { modelId: `${tier}-model` }]),
    ) as Record<ModelTier, LanguageModel>;
    const prepareStep = createModelTierPrepareStep({
      initialTier: "chat",
      tierModels,
      escalationMode: "fixed-tier",
    });

    const result = prepareStep({
      steps: [{ toolCalls: [{ toolName: "program_week" }] }],
      stepNumber: 1,
      model: tierModels.chat,
      messages: [],
      experimental_context: undefined,
    } as Parameters<typeof prepareStep>[0]);

    expect(result).toEqual({ model: tierModels.chat });
  });
});
