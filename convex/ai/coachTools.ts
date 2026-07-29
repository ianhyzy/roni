import type { ToolSet } from "ai";
import { withAnthropicToolCache } from "./anthropicCache";
import {
  advanceTrainingBlockTool,
  checkDeloadTool,
  getGoalsTool,
  getInjuriesTool,
  getRecentFeedbackTool,
  getWeeklyVolumeTool,
  recordFeedbackTool,
  reportInjuryTool,
  resolveInjuryTool,
  setGoalTool,
  startTrainingBlockTool,
  updateGoalProgressTool,
} from "./coachingTools";
import { estimateDurationTool } from "./estimationTools";
import { estimateMessagesTokens } from "./contextWindow";
import { programWeekTool } from "./programWeekTool";
import { rebuildDayTool } from "./rebuildDayTool";
import { analyzeVolumeStrengthTool } from "./volumeStrengthTool";
import {
  createWorkoutTool,
  deleteWorkoutTool,
  getMuscleReadinessTool,
  getStrengthHistoryTool,
  getStrengthScoresTool,
  getTrainingFrequencyTool,
  getWorkoutDetailTool,
  getWorkoutHistoryTool,
  searchExercisesTool,
} from "./tools";
import {
  addExerciseTool,
  adjustSessionDurationTool,
  moveSessionTool,
  setWarmupBlockTool,
  swapExerciseTool,
} from "./weekModificationTools";
import {
  approveWeekPlanTool,
  deleteWeekPlanTool,
  getWeekPlanDetailsTool,
  getWorkoutPerformanceTool,
} from "./weekTools";

const TOOL_SCHEMA_TOKEN_FALLBACK = 120;

const RAW_COACH_TOOLS = {
  search_exercises: searchExercisesTool,
  get_strength_scores: getStrengthScoresTool,
  get_strength_history: getStrengthHistoryTool,
  get_muscle_readiness: getMuscleReadinessTool,
  get_workout_history: getWorkoutHistoryTool,
  get_workout_detail: getWorkoutDetailTool,
  get_training_frequency: getTrainingFrequencyTool,
  create_workout: createWorkoutTool,
  delete_workout: deleteWorkoutTool,
  estimate_duration: estimateDurationTool,
  program_week: programWeekTool,
  get_week_plan_details: getWeekPlanDetailsTool,
  delete_week_plan: deleteWeekPlanTool,
  approve_week_plan: approveWeekPlanTool,
  get_workout_performance: getWorkoutPerformanceTool,
  swap_exercise: swapExerciseTool,
  add_exercise: addExerciseTool,
  set_warmup_block: setWarmupBlockTool,
  move_session: moveSessionTool,
  adjust_session_duration: adjustSessionDurationTool,
  rebuild_day: rebuildDayTool,
  record_feedback: recordFeedbackTool,
  get_recent_feedback: getRecentFeedbackTool,
  check_deload: checkDeloadTool,
  start_training_block: startTrainingBlockTool,
  advance_training_block: advanceTrainingBlockTool,
  set_goal: setGoalTool,
  update_goal_progress: updateGoalProgressTool,
  get_goals: getGoalsTool,
  report_injury: reportInjuryTool,
  resolve_injury: resolveInjuryTool,
  get_injuries: getInjuriesTool,
  get_weekly_volume: getWeeklyVolumeTool,
  analyze_volume_strength: analyzeVolumeStrengthTool,
} satisfies ToolSet;

export type CoachToolName = keyof typeof RAW_COACH_TOOLS;
export type CoachToolMode = "all" | "weekly_programming";

const ALL_COACH_TOOL_NAMES = Object.freeze(Object.keys(RAW_COACH_TOOLS) as CoachToolName[]);
const ONE_OFF_WORKOUT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_workout",
  "delete_workout",
]);
const WEEKLY_APPROVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "approve_week_plan",
  "delete_week_plan",
]);
const STRONG_ONE_OFF_PATTERNS = [/\b(?:standalone|one[- ]off)\s+(?:custom\s+)?workout\b/] as const;
const CONTEXTUAL_ONE_OFF_PATTERNS = [
  /\b(?:one|single)\s+(?:custom\s+)?workout\b/,
  /\b(?:this|that)\s+(?:custom\s+)?workout\b/,
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:['’]s)?\s+workout\b/,
] as const;
const WEEKLY_WORKFLOW_PATTERNS = [
  /^(?:please\s+)?(?:(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?give me|i (?:need|want))\b.{0,60}\b(?:weekly|week plan|ppl|push\s*[/+-]?\s*pull\s*[/+-]?\s*legs|upper\s*[/+-]?\s*lower|full[- ]?body\s+split|bro\s+split|\d+\s*[- ]day\s+(?:routine|plan|schedule|split|program))\b/,
  /\b(?:for\s+)?(?:next|this)\s+week\b.{0,60}\b(?:program|plan|build|create|make|set up|generate|draft|give)\b.{0,40}\b(?:plan|schedule|split|routine|workouts)\b/,
  /\b(?:program|plan|build|create|make|set up|generate|draft|push|approve|delete|discard)\b.{0,60}\b(?:weekly|week(?:['’]s)?|full[- ]week|training block)\s+(?:plan|program|schedule|split|routine|workouts?)\b/,
  /\b(?:program|plan|build|create|make|set up|generate|draft|delete|discard)\b.{0,60}\b(?:workout\s+)?(?:plan|schedule)\b.{0,30}\b(?:for|of|from)\s+(?:next|this|the|my)?\s*week\b/,
  /\b(?:program|plan|schedule)\b(?:(?!\bworkout\b).){0,30}\b(?:next|this|the)?\s*week\b/,
  /\b(?:push|approve)\b.{0,60}\bworkout\s+week(?:\s+\d+)?\b/,
  /\b(?:next|this)\s+week\b.{0,60}\b(?:push|approve)\b/,
  /\b(?:program|plan|build|create|make|set up)\b.{0,60}\b(?:ppl|push\s*[/+-]?\s*pull\s*[/+-]?\s*legs|upper\s*[/+-]?\s*lower|full[- ]?body\s+split|bro\s+split)\b/,
  /\b(?:program|plan|build|create|make|set up|schedule)\b.{0,60}(?:\bworkouts\b|\b\d+\s*[- ]day\s+(?:routine|plan|schedule|split|program)\b)/,
  /\b(?:program|plan|build|create|make|set up)\b.{0,50}\bdeload(?:\s+(?:week|plan))?\b/,
] as const;
const WEEKLY_FOLLOW_UP_PATTERNS = [
  /^(?:looks?|sounds?) good(?:[,.]?\s+(?:send|push|approve)\s+(?:it|them|the plan))?[.!]?$/,
  /^(?:send|push|approve|delete|discard)(?:\s+(?:it|them|the plan))?[.!]?$/,
  /^go ahead(?:\s+and\s+(?:send|push|approve)\s+(?:it|them|the plan))?[.!]?$/,
  /^start over[.!]?$/,
] as const;

export function classifyCoachToolMode(prompt: string, hasCurrentWeekPlan = false): CoachToolMode {
  const normalized = prompt.trim().toLowerCase();
  if (STRONG_ONE_OFF_PATTERNS.some((pattern) => pattern.test(normalized))) return "all";
  if (WEEKLY_WORKFLOW_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "weekly_programming";
  }
  if (CONTEXTUAL_ONE_OFF_PATTERNS.some((pattern) => pattern.test(normalized))) return "all";
  if (hasCurrentWeekPlan && WEEKLY_FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return "weekly_programming";
  }
  return "all";
}

export function selectCoachActiveTools(mode: CoachToolMode): CoachToolName[] | undefined {
  if (mode === "all") return undefined;
  return ALL_COACH_TOOL_NAMES.filter((toolName) => !ONE_OFF_WORKOUT_TOOL_NAMES.has(toolName));
}

export function selectApprovalContinuationToolMode(toolNames: readonly string[]): CoachToolMode {
  if (toolNames.some((name) => ONE_OFF_WORKOUT_TOOL_NAMES.has(name))) return "all";
  return toolNames.some((name) => WEEKLY_APPROVAL_TOOL_NAMES.has(name))
    ? "weekly_programming"
    : "all";
}

export const COACH_TOOLS = withAnthropicToolCache(RAW_COACH_TOOLS);

function getToolDescription(tool: unknown): string {
  if (tool === null || typeof tool !== "object" || !("description" in tool)) return "";
  const description = Reflect.get(tool, "description");
  return typeof description === "string" ? description : "";
}

function estimateToolDefinitionTokens(tools: ToolSet): number {
  return Object.entries(tools).reduce((sum, [name, tool]) => {
    const description = getToolDescription(tool);
    return (
      sum +
      estimateMessagesTokens([{ role: "system", content: `${name}\n${description}` }]) +
      TOOL_SCHEMA_TOKEN_FALLBACK
    );
  }, 0);
}

export const ESTIMATED_TOOL_DEFINITION_TOKENS = estimateToolDefinitionTokens(COACH_TOOLS);
