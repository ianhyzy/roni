"use client";

import { AlertTriangle } from "lucide-react";
import { WeekPlanCard } from "./WeekPlanCard";
import { ActionConfirmationBanner } from "./ActionConfirmationBanner";
import { extractBannerProps } from "./bannerExtractors";
import {
  isFailedProgramWeekOutput,
  isWeekPlanCardToolName,
  toWeekPlanPresentation,
  WEEK_PLAN_CARD_TOOL_NAMES,
} from "./weekPlanCardData";

export const SPECIAL_RENDERER_TOOL_NAMES = WEEK_PLAN_CARD_TOOL_NAMES;
export const STATE_CHANGING_TOOL_NAMES = [
  "create_workout",
  "delete_workout",
  "program_week",
  "delete_week_plan",
  "approve_week_plan",
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
  "exclude_exercises",
  "unexclude_exercises",
] as const;

const STATE_CHANGING_TOOLS: ReadonlySet<string> = new Set(STATE_CHANGING_TOOL_NAMES);

const TOOL_MESSAGES: Record<string, { running: string; done: string }> = {
  search_exercises: {
    running: "Searching exercises...",
    done: "Searched exercises",
  },
  get_strength_scores: {
    running: "Checking strength scores...",
    done: "Checked strength scores",
  },
  get_strength_history: {
    running: "Reviewing strength history...",
    done: "Reviewed strength history",
  },
  get_muscle_readiness: {
    running: "Checking muscle readiness...",
    done: "Checked muscle readiness",
  },
  get_workout_history: {
    running: "Reviewing workout history...",
    done: "Reviewed workout history",
  },
  get_workout_detail: {
    running: "Loading workout details...",
    done: "Loaded workout details",
  },
  get_training_frequency: {
    running: "Analyzing training frequency...",
    done: "Analyzed training frequency",
  },
  create_workout: {
    running: "Creating workout...",
    done: "Created workout",
  },
  delete_workout: {
    running: "Deleting workout...",
    done: "Deleted workout",
  },
  estimate_duration: {
    running: "Estimating duration...",
    done: "Estimated duration",
  },
  program_week: {
    running: "Programming your week...",
    done: "Week programmed",
  },
  get_week_plan_details: {
    running: "Loading week plan...",
    done: "Loaded week plan",
  },
  delete_week_plan: {
    running: "Deleting week plan...",
    done: "Deleted week plan",
  },
  swap_exercise: {
    running: "Swapping exercise...",
    done: "Swapped exercise",
  },
  move_session: {
    running: "Moving session...",
    done: "Moved session",
  },
  adjust_session_duration: {
    running: "Adjusting session...",
    done: "Adjusted session",
  },
  approve_week_plan: {
    running: "Pushing workouts to your Tonal...",
    done: "Workouts pushed to Tonal",
  },
  get_workout_performance: {
    running: "Analyzing your performance...",
    done: "Performance analyzed",
  },
  exclude_exercises: {
    running: "Excluding exercises...",
    done: "Exercises excluded",
  },
  unexclude_exercises: {
    running: "Removing exclusions...",
    done: "Exclusions removed",
  },
  get_exercise_exclusions: {
    running: "Checking excluded exercises...",
    done: "Checked excluded exercises",
  },
};

interface ToolCallIndicatorProps {
  toolName: string;
  state: string;
  output?: unknown;
}

export function ToolCallIndicator({ toolName, state, output }: ToolCallIndicatorProps) {
  const messages = TOOL_MESSAGES[toolName] ?? {
    running: `Running ${toolName}...`,
    done: `Ran ${toolName}`,
  };
  const isRunning = state === "input-streaming" || state === "input-available";
  const isDone = state === "output-available";
  const isMissingWeekPlan =
    isDone &&
    toolName === "get_week_plan_details" &&
    typeof output === "object" &&
    output !== null &&
    "found" in output &&
    output.found === false;
  const unconfirmedResult = (
    <span
      className="inline-flex items-center gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1 text-xs text-amber-700 dark:text-amber-300"
      role="status"
    >
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
      This change could not be confirmed.
    </span>
  );

  if (state === "output-error") {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md bg-destructive/10 px-2.5 py-1 text-xs text-destructive"
        role="alert"
      >
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
        Roni couldn&apos;t complete this step.
      </span>
    );
  }

  // program_week and get_week_plan_details render the full week-plan card.
  if (isWeekPlanCardToolName(toolName) && isDone && output) {
    const plan = toWeekPlanPresentation(toolName, output);
    if (plan) return <WeekPlanCard plan={plan} />;

    // program_week is state-changing, so an unrenderable payload is worth
    // flagging — unless the tool reported an outright failure, which the
    // error banner below describes far better than "could not be confirmed".
    if (toolName === "program_week" && !isFailedProgramWeekOutput(output)) {
      return unconfirmedResult;
    }
    // get_week_plan_details is a read: "no plan this week" is a normal answer,
    // so fall through to the plain chip rather than warning about it.
  }

  // State-changing tools: show confirmation banner when done
  if (isDone) {
    const bannerProps = extractBannerProps(toolName, output);
    if (bannerProps) {
      return <ActionConfirmationBanner {...bannerProps} />;
    }
    if (STATE_CHANGING_TOOLS.has(toolName)) return unconfirmedResult;
  }

  // Unified chip layout for both running and done
  if (isRunning) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground"
        role="status"
      >
        <span
          className="inline-block size-1.5 rounded-full bg-primary motion-safe:animate-[tool-pulse_2s_ease-in-out_infinite]"
          aria-hidden="true"
        />
        {messages.running}
      </span>
    );
  }

  if (isDone) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-md bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground"
        role={isMissingWeekPlan ? "status" : undefined}
      >
        <span className="text-primary" aria-hidden="true">
          {isMissingWeekPlan ? "—" : "✓"}
        </span>
        {isMissingWeekPlan ? "No week plan found" : messages.done}
      </span>
    );
  }

  return null;
}
