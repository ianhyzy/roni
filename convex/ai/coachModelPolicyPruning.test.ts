import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { createModelTierPrepareStep } from "./coach";
import {
  ALL_COACH_TOOL_NAMES,
  type CoachToolMode,
  estimateCoachToolDefinitionTokens,
} from "./coachTools";
import { MODEL_TIERS, type ModelTier } from "./providers";

const TIER_MODELS = Object.fromEntries(
  MODEL_TIERS.map((tier) => [tier, { modelId: `${tier}-model` }]),
) as Record<ModelTier, LanguageModel>;
const PRUNED_TOOL_NAMES = ALL_COACH_TOOL_NAMES.filter(
  (toolName) => toolName !== "program_week" && toolName !== "delete_week_plan",
);
type PolicyStep = Parameters<ReturnType<typeof createModelTierPrepareStep>>[0]["steps"][number];

const successfulProgramWeek: PolicyStep[] = [
  {
    toolCalls: [{ toolName: "program_week" }],
    toolResults: [{ toolName: "program_week", output: { success: true } }],
  },
];

function runPrepareStep(steps: readonly PolicyStep[], toolMode: CoachToolMode = "all") {
  const prepareStep = createModelTierPrepareStep({
    initialTier: "programming",
    tierModels: TIER_MODELS,
    toolMode,
  });
  return { prepareStep, result: prepareStep({ steps }) };
}

describe("coach tool pruning after week programming", () => {
  it.each(["all", "weekly_programming"] satisfies CoachToolMode[])(
    "prunes week creation and deletion in %s mode",
    (toolMode) => {
      const { result } = runPrepareStep(successfulProgramWeek, toolMode);

      expect(result.activeTools).not.toContain("program_week");
      expect(result.activeTools).not.toContain("delete_week_plan");
      expect(result.activeTools).toContain("approve_week_plan");
      expect(result.activeTools).toContain("rebuild_day");
      if (toolMode === "weekly_programming") {
        expect(result.activeTools).not.toContain("create_workout");
      } else {
        expect(result.activeTools).toEqual(PRUNED_TOOL_NAMES);
      }
    },
  );

  it.each([
    [
      "failed result",
      [{ toolResults: [{ toolName: "program_week", output: { success: false } }] }],
    ],
    ["null result", [{ toolResults: [{ toolName: "program_week", output: null }] }]],
    [
      "non-boolean success",
      [{ toolResults: [{ toolName: "program_week", output: { success: "true" } }] }],
    ],
    ["call without result", [{ toolCalls: [{ toolName: "program_week" }] }]],
    [
      "unrelated success",
      [{ toolResults: [{ toolName: "search_exercises", output: { success: true } }] }],
    ],
  ] satisfies ReadonlyArray<readonly [string, PolicyStep[]]>)(
    "keeps week tools available after a %s",
    (_label, steps) => {
      const { result } = runPrepareStep(steps, "weekly_programming");

      expect(result.activeTools).toContain("program_week");
      expect(result.activeTools).toContain("delete_week_plan");
    },
  );

  it("preserves chat-to-programming escalation while pruning", () => {
    const prepareStep = createModelTierPrepareStep({
      initialTier: "chat",
      tierModels: TIER_MODELS,
    });

    const result = prepareStep({ steps: successfulProgramWeek });

    expect(result.model).toBe(TIER_MODELS.programming);
    expect(result.activeTools).toEqual(PRUNED_TOOL_NAMES);
  });

  it("preserves the fixed fallback tier while pruning", () => {
    const prepareStep = createModelTierPrepareStep({
      initialTier: "chat",
      tierModels: TIER_MODELS,
      escalationMode: "fixed-tier",
      toolMode: "weekly_programming",
    });

    const result = prepareStep({ steps: successfulProgramWeek });

    expect(result.model).toBe(TIER_MODELS.chat);
    expect(result.activeTools).not.toContain("program_week");
    expect(result.activeTools).not.toContain("delete_week_plan");
    expect(result.activeTools).not.toContain("create_workout");
  });

  it("re-enables week tools when a new stream starts", () => {
    const { prepareStep, result: completedResult } = runPrepareStep(successfulProgramWeek);

    const newStreamResult = prepareStep({ steps: [] });

    expect(completedResult.activeTools).toEqual(PRUNED_TOOL_NAMES);
    expect(newStreamResult.activeTools).toBeUndefined();
  });

  it("reduces the estimate by the removed tools' definition tokens", () => {
    const before = estimateCoachToolDefinitionTokens(ALL_COACH_TOOL_NAMES);
    const after = estimateCoachToolDefinitionTokens(PRUNED_TOOL_NAMES);
    const removed = estimateCoachToolDefinitionTokens(["program_week", "delete_week_plan"]);

    expect(after).toBeLessThan(before);
    expect(removed).toBeGreaterThan(0);
    expect(before - after).toBe(removed);
  });
});
