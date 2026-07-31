type BannerProps = { variant: "success" | "error"; message: string };
type Extractor = (output: unknown) => BannerProps | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

const approveWeekPlan: Extractor = (output) => {
  if (!isRecord(output)) return null;
  if (typeof output.error === "string") {
    return { variant: "error", message: output.error };
  }

  const pushed = output.pushed;
  const failed = output.failed;
  const schedulingFailed = output.schedulingFailed === undefined ? 0 : output.schedulingFailed;
  const deferred = output.deferred === undefined ? 0 : output.deferred;
  const hasCounts =
    isNonnegativeInteger(pushed) &&
    isNonnegativeInteger(failed) &&
    isNonnegativeInteger(schedulingFailed) &&
    isNonnegativeInteger(deferred);

  if (output.success === false) {
    if (!hasCounts || (failed === 0 && schedulingFailed === 0 && deferred === 0)) {
      return { variant: "error", message: "Failed to push workouts to Tonal" };
    }
  }

  if ((output.success !== true && output.success !== false) || !hasCounts) return null;

  if (failed > 0 || schedulingFailed > 0 || deferred > 0) {
    const outcomes = [`${pushed} pushed`];
    if (failed > 0) outcomes.push(`${failed} failed`);
    if (schedulingFailed > 0) {
      outcomes.push(`${schedulingFailed} calendar scheduling failed`);
    }
    if (deferred > 0) outcomes.push(`${deferred} deferred`);

    const retryGuidance = deferred > 0 ? ". Retry approval to finish" : "";
    return { variant: "error", message: `${outcomes.join(", ")}${retryGuidance}` };
  }
  return { variant: "success", message: `${pushed} workouts pushed to Tonal` };
};

function booleanSentinel(field: string, successMsg: string, errorMsg: string): Extractor {
  return (output) => {
    if (!isRecord(output)) return null;
    if (output[field] === true) return { variant: "success", message: successMsg };
    if (output[field] === false) return { variant: "error", message: errorMsg };
    return null;
  };
}

function successBoolean(successMsg: string, errorMsg: string): Extractor {
  return booleanSentinel("success", successMsg, errorMsg);
}

function deletedBoolean(successMsg: string, errorMsg: string): Extractor {
  return booleanSentinel("deleted", successMsg, errorMsg);
}

export const ACTION_BANNER_TOOL_NAMES = [
  "approve_week_plan",
  "create_workout",
  "delete_workout",
  "delete_week_plan",
  "swap_exercise",
  "add_exercise",
  "set_warmup_block",
  "move_session",
  "adjust_session_duration",
  "rebuild_day",
  "record_feedback",
  "start_training_block",
  "advance_training_block",
  "set_goal",
  "update_goal_progress",
  "report_injury",
  "resolve_injury",
] as const;

type ActionBannerToolName = (typeof ACTION_BANNER_TOOL_NAMES)[number];

function isActionBannerToolName(toolName: string): toolName is ActionBannerToolName {
  return ACTION_BANNER_TOOL_NAMES.some((name) => name === toolName);
}

const ACTION_EXTRACTORS: Record<ActionBannerToolName, Extractor> = {
  approve_week_plan: approveWeekPlan,
  create_workout: successBoolean("Workout created", "Failed to create workout"),
  delete_workout: deletedBoolean("Workout deleted", "Failed to delete workout"),
  delete_week_plan: deletedBoolean("Week plan deleted", "Failed to delete week plan"),
  swap_exercise: successBoolean("Exercise swapped", "Failed to swap exercise"),
  add_exercise: successBoolean("Exercise added", "Failed to add exercise"),
  set_warmup_block: successBoolean("Warmup updated", "Failed to update warmup"),
  move_session: successBoolean("Session moved", "Failed to move session"),
  adjust_session_duration: successBoolean("Session adjusted", "Failed to adjust session"),
  rebuild_day: successBoolean("Workout rebuilt", "Failed to rebuild workout"),
  record_feedback: booleanSentinel("recorded", "Feedback recorded", "Failed to record feedback"),
  start_training_block: booleanSentinel(
    "started",
    "Training block started",
    "Failed to start training block",
  ),
  advance_training_block: booleanSentinel(
    "advanced",
    "Training block advanced",
    "Failed to advance training block",
  ),
  set_goal: booleanSentinel("created", "Goal created", "Failed to create goal"),
  update_goal_progress: booleanSentinel(
    "updated",
    "Goal progress updated",
    "Failed to update goal progress",
  ),
  report_injury: booleanSentinel("recorded", "Injury recorded", "Failed to record injury"),
  resolve_injury: booleanSentinel("resolved", "Injury resolved", "Failed to resolve injury"),
};

export function extractBannerProps(toolName: string, output: unknown): BannerProps | null {
  if (!isActionBannerToolName(toolName)) return null;
  return ACTION_EXTRACTORS[toolName](output);
}
