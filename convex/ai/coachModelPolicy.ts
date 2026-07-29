import type { LanguageModel } from "ai";
import { ALL_COACH_TOOL_NAMES, type CoachToolMode, selectCoachActiveTools } from "./coachTools";
import type { ModelTier } from "./providers";

const PROGRAMMING_TOOL_NAMES = new Set<string>([
  "add_exercise",
  "adjust_session_duration",
  "advance_training_block",
  "approve_week_plan",
  "check_deload",
  "create_workout",
  "delete_week_plan",
  "delete_workout",
  "move_session",
  "program_week",
  "rebuild_day",
  "set_warmup_block",
  "start_training_block",
  "swap_exercise",
]);
const POST_PROGRAM_WEEK_REMOVALS: ReadonlySet<string> = new Set([
  "program_week",
  "delete_week_plan",
]);

interface ModelTierStep {
  toolCalls?: ReadonlyArray<{ toolName: string }>;
  toolResults?: ReadonlyArray<{ toolName: string; output: unknown }>;
}

export type ModelTierPrepareStep = (options: { steps: ReadonlyArray<ModelTierStep> }) => {
  model: LanguageModel;
  activeTools?: string[];
};

export function selectCoachPrepareStepTier(
  initialTier: ModelTier,
  steps: ReadonlyArray<ModelTierStep>,
): ModelTier {
  if (initialTier === "programming" || initialTier === "router") return initialTier;
  const hasProgrammingToolCall = steps.some((step) =>
    step.toolCalls?.some((toolCall) => PROGRAMMING_TOOL_NAMES.has(toolCall.toolName)),
  );
  return hasProgrammingToolCall ? "programming" : initialTier;
}

export function createModelTierPrepareStep(args: {
  initialTier: ModelTier;
  tierModels: Record<ModelTier, LanguageModel>;
  escalationMode?: "allow-programming" | "fixed-tier";
  toolMode?: CoachToolMode;
}): ModelTierPrepareStep {
  const { initialTier, tierModels, escalationMode = "allow-programming", toolMode = "all" } = args;
  const baseActiveTools = selectCoachActiveTools(toolMode);
  return ({ steps }) => {
    const tier =
      escalationMode === "fixed-tier"
        ? initialTier
        : selectCoachPrepareStepTier(initialTier, steps);
    const activeTools = hasSuccessfulProgramWeekResult(steps)
      ? (baseActiveTools ?? ALL_COACH_TOOL_NAMES).filter(
          (toolName) => !POST_PROGRAM_WEEK_REMOVALS.has(toolName),
        )
      : baseActiveTools;
    return { model: tierModels[tier], ...(activeTools && { activeTools }) };
  };
}

function hasSuccessfulProgramWeekResult(steps: ReadonlyArray<ModelTierStep>): boolean {
  return steps.some((step) =>
    step.toolResults?.some(
      (result) =>
        result.toolName === "program_week" &&
        typeof result.output === "object" &&
        result.output !== null &&
        !Array.isArray(result.output) &&
        Reflect.get(result.output, "success") === true,
    ),
  );
}
