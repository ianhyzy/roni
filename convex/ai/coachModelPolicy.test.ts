import { describe, expect, it } from "vitest";
import type { LanguageModel } from "ai";
import {
  buildCoachAgentsForProvider,
  createModelTierPrepareStep,
  selectCoachPrepareStepTier,
} from "./coach";
import { classifyCoachToolMode, selectApprovalContinuationToolMode } from "./coachTools";
import { MODEL_TIERS, type ModelTier } from "./providers";

describe("coach tool mode classification", () => {
  it.each([
    "Push Bens workout week 1 Monday",
    "Build my weekly schedule",
    "Create a workout schedule for the week",
    "Create this workout schedule for the week",
    "Delete this workout from my weekly plan",
    "Delete one workout from my weekly plan",
    "Create a single workout schedule for the week",
    "Delete my weekly plan",
    "Discard this week's plan",
    "Make me a PPL split",
    "Set up upper-lower",
    "Next week, push Monday's workout",
    "Create workouts for Monday, Wednesday, and Friday",
    "Build me a 4-day routine",
    "Give me a 3-day plan",
    "Can you give me a 3-day plan?",
    "Could you give me a PPL split?",
    "Will you give me an upper-lower split?",
    "Would you please give me a weekly schedule?",
    "I need a PPL split",
    "For next week, create me a workout plan",
  ])("restricts actionable weekly prompt: %s", (prompt) => {
    expect(classifyCoachToolMode(prompt)).toBe("weekly_programming");
  });

  it.each([
    "Push this one-off workout",
    "Build me a chest workout",
    "Create a standalone workout for my trip next week",
    "Create a chest workout for my trip next week",
    "For next week, create me a chest workout",
    "For next week, create me a standalone workout plan",
    "For next week, create me a one-off workout plan",
    "Can you give me a one-off workout for my PPL week?",
    "Go ahead and push Monday’s workout to Tonal",
    "What do I need to know about PPL?",
    "What is PPL?",
  ])("keeps non-weekly prompt unrestricted: %s", (prompt) => {
    expect(classifyCoachToolMode(prompt)).toBe("all");
  });

  it("uses the current week plan only for terse lifecycle follow-ups", () => {
    expect(classifyCoachToolMode("sounds good push it.", true)).toBe("weekly_programming");
    expect(classifyCoachToolMode("sounds good push it.", false)).toBe("all");
    expect(classifyCoachToolMode("Build me a chest workout", true)).toBe("all");
    expect(classifyCoachToolMode("Go ahead and push Monday’s workout", true)).toBe("all");
    expect(classifyCoachToolMode("Go ahead and build me a chest workout", true)).toBe("all");
    expect(classifyCoachToolMode("Looks good, now build me a chest workout", true)).toBe("all");
    expect(classifyCoachToolMode("Create a chest workout and push it", true)).toBe("all");
  });
});

describe("approval continuation tool mode", () => {
  it("preserves weekly restrictions for week-plan approvals", () => {
    expect(selectApprovalContinuationToolMode(["approve_week_plan"])).toBe("weekly_programming");
    expect(selectApprovalContinuationToolMode(["delete_week_plan"])).toBe("weekly_programming");
  });

  it("keeps standalone and legacy approvals unrestricted", () => {
    expect(selectApprovalContinuationToolMode(["create_workout"])).toBe("all");
    expect(selectApprovalContinuationToolMode([])).toBe("all");
  });
});

describe("coach agent model tiers", () => {
  it("builds Gemini tier metadata without preview defaults", () => {
    const agents = buildCoachAgentsForProvider({
      provider: "gemini",
      apiKey: "test-gemini-key",
    });

    expect(agents.tierModelNames).toEqual({
      router: "gemini-3.5-flash-lite",
      chat: "gemini-3.6-flash",
      programming: "gemini-3.6-flash",
      summarize: "gemini-3.5-flash-lite",
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

    expect(result).toMatchObject({ model: tierModels.programming });
  });

  it("keeps one-off workout tools out of weekly programming steps", () => {
    const tierModels = Object.fromEntries(
      MODEL_TIERS.map((tier) => [tier, { modelId: `${tier}-model` }]),
    ) as Record<ModelTier, LanguageModel>;
    const prepareStep = createModelTierPrepareStep({
      initialTier: "programming",
      tierModels,
      toolMode: "weekly_programming",
    });

    const result = prepareStep({
      steps: [],
      stepNumber: 0,
      model: tierModels.programming,
      messages: [],
      experimental_context: undefined,
    } as Parameters<typeof prepareStep>[0]);

    expect(result.activeTools).toContain("program_week");
    expect(result.activeTools).toContain("search_exercises");
    expect(result.activeTools).toContain("delete_week_plan");
    expect(result.activeTools).toContain("rebuild_day");
    expect(result.activeTools).toContain("check_deload");
    expect(result.activeTools).not.toContain("create_workout");
    expect(result.activeTools).not.toContain("delete_workout");
  });

  it("keeps fallback prepareStep on the fixed fallback tier", () => {
    const tierModels = Object.fromEntries(
      MODEL_TIERS.map((tier) => [tier, { modelId: `${tier}-model` }]),
    ) as Record<ModelTier, LanguageModel>;
    const prepareStep = createModelTierPrepareStep({
      initialTier: "chat",
      tierModels,
      escalationMode: "fixed-tier",
      toolMode: "weekly_programming",
    });

    const result = prepareStep({
      steps: [{ toolCalls: [{ toolName: "program_week" }] }],
      stepNumber: 1,
      model: tierModels.chat,
      messages: [],
      experimental_context: undefined,
    } as Parameters<typeof prepareStep>[0]);

    expect(result).toMatchObject({ model: tierModels.chat });
    expect(result.activeTools).not.toContain("create_workout");
    expect(result.activeTools).not.toContain("delete_workout");
  });
});
