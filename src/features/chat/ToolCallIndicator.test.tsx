import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SPECIAL_RENDERER_TOOL_NAMES,
  STATE_CHANGING_TOOL_NAMES,
  ToolCallIndicator,
} from "./ToolCallIndicator";
import { ACTION_BANNER_TOOL_NAMES } from "./bannerExtractors";

type MockWeekPlan = {
  summary: string;
  days: { exercises: { name: string; reps?: number; duration?: number }[] }[];
};

vi.mock("./WeekPlanCard", () => ({
  WeekPlanCard: ({ plan }: { plan: MockWeekPlan }) => (
    <div data-testid="week-plan-card">
      <span>{plan.summary}</span>
      {plan.days.flatMap((day) =>
        day.exercises.map((exercise) => (
          <span key={exercise.name}>
            {exercise.name} duration:{exercise.duration ?? "none"} reps:{exercise.reps ?? "none"}
          </span>
        )),
      )}
    </div>
  ),
}));

const validProgramWeekDay = {
  dayIndex: 0,
  dayName: "Monday",
  sessionType: "push",
  estimatedDuration: 45,
  exercises: [{ name: "Bench Press", muscleGroups: ["Chest"], sets: 3, reps: 10 }],
};

function createProgramWeekOutput(
  overrides: { weekStartDate?: unknown; preferredSplit?: unknown; days?: unknown[] } = {},
) {
  return {
    success: true,
    summary: {
      weekStartDate: overrides.weekStartDate ?? "2026-04-13",
      preferredSplit: overrides.preferredSplit ?? "ppl",
      days: overrides.days ?? [validProgramWeekDay],
    },
  };
}

describe("ToolCallIndicator", () => {
  it("covers every state-changing tool with a banner extractor or special renderer", () => {
    const coveredToolNames = new Set([...ACTION_BANNER_TOOL_NAMES, ...SPECIAL_RENDERER_TOOL_NAMES]);

    // Every state-changing tool must render something better than a bare chip.
    // The reverse doesn't hold: get_week_plan_details is a read that still
    // earns the full card.
    for (const toolName of STATE_CHANGING_TOOL_NAMES) {
      expect(coveredToolNames).toContain(toolName);
    }
    expect(new Set(ACTION_BANNER_TOOL_NAMES).size).toBe(ACTION_BANNER_TOOL_NAMES.length);
    expect(new Set(STATE_CHANGING_TOOL_NAMES).size).toBe(STATE_CHANGING_TOOL_NAMES.length);
    expect(STATE_CHANGING_TOOL_NAMES).toHaveLength(18);
    expect(SPECIAL_RENDERER_TOOL_NAMES).toEqual(["program_week", "get_week_plan_details"]);
  });

  it("renders running chip for a state-changing tool in progress", () => {
    render(<ToolCallIndicator toolName="approve_week_plan" state="input-available" />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Pushing workouts to your Tonal...")).toBeInTheDocument();
  });

  it("renders confirmation banner for a stored approve_week_plan success", () => {
    render(
      <ToolCallIndicator
        toolName="approve_week_plan"
        state="output-available"
        output={{
          success: true,
          pushed: 4,
          failed: 0,
          skipped: 3,
          results: [],
        }}
      />,
    );

    expect(screen.getByText("4 workouts pushed to Tonal")).toBeInTheDocument();
    expect(
      screen.getByRole("status").querySelector("[data-testid='banner-icon-success']"),
    ).toBeInTheDocument();
  });

  it("renders error banner for approve_week_plan on failure", () => {
    render(
      <ToolCallIndicator
        toolName="approve_week_plan"
        state="output-available"
        output={{
          success: false,
          pushed: 2,
          failed: 1,
          schedulingFailed: 0,
          deferred: 0,
          skipped: 0,
          results: [],
        }}
      />,
    );

    expect(screen.getByText("2 pushed, 1 failed")).toBeInTheDocument();
    expect(
      screen.getByRole("status").querySelector("[data-testid='banner-icon-error']"),
    ).toBeInTheDocument();
  });

  it("renders confirmation banner for swap_exercise on success", () => {
    render(
      <ToolCallIndicator
        toolName="swap_exercise"
        state="output-available"
        output={{ success: true, message: "Swapped" }}
      />,
    );

    expect(screen.getByText("Exercise swapped")).toBeInTheDocument();
  });

  it.each([
    ["add_exercise", { success: true }, "Exercise added"],
    ["set_warmup_block", { success: true }, "Warmup updated"],
    ["rebuild_day", { success: true }, "Workout rebuilt"],
    ["record_feedback", { recorded: true }, "Feedback recorded"],
    ["report_injury", { recorded: true }, "Injury recorded"],
    ["start_training_block", { started: true }, "Training block started"],
    ["advance_training_block", { advanced: true }, "Training block advanced"],
    ["set_goal", { created: true }, "Goal created"],
    ["update_goal_progress", { updated: true }, "Goal progress updated"],
    ["resolve_injury", { resolved: true }, "Injury resolved"],
  ])("renders a truthful confirmation for %s", (toolName, output, message) => {
    render(<ToolCallIndicator toolName={toolName} state="output-available" output={output} />);

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("does not claim success when a state-changing output is unexpected", () => {
    render(
      <ToolCallIndicator
        toolName="approve_week_plan"
        state="output-available"
        output="unexpected string"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("This change could not be confirmed.");
    expect(screen.queryByText("Workouts pushed to Tonal")).not.toBeInTheDocument();
  });

  it("shows a generic error without exposing tool error details", () => {
    render(
      <ToolCallIndicator
        toolName="approve_week_plan"
        state="output-error"
        output="provider-key-secret"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Roni couldn't complete this step.");
    expect(screen.queryByText("provider-key-secret")).not.toBeInTheDocument();
  });

  it("requires confirmation for state-changing tools without a custom banner", () => {
    render(
      <ToolCallIndicator toolName="set_goal" state="output-available" output={{ ok: true }} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("This change could not be confirmed.");
  });

  it("renders chip for read-only tools", () => {
    render(<ToolCallIndicator toolName="search_exercises" state="output-available" />);

    expect(screen.getByText("Searched exercises")).toBeInTheDocument();
  });

  it("renders WeekPlanCard for get_week_plan_details so edits after program_week stay visible", () => {
    render(
      <ToolCallIndicator
        toolName="get_week_plan_details"
        state="output-available"
        output={{
          found: true,
          plan: {
            weekStartDate: "2026-08-03",
            preferredSplit: "upper_lower",
            targetDays: 4,
            days: [
              {
                dayIndex: 0,
                dayName: "Monday",
                sessionType: "upper",
                status: "draft",
                estimatedDuration: 30,
                exercises: [
                  {
                    movementId: "m1",
                    name: "Standing Chest Press",
                    muscleGroups: ["Chest"],
                    sets: 3,
                    reps: 10,
                  },
                ],
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByTestId("week-plan-card")).toBeInTheDocument();
    expect(screen.getByText(/Standing Chest Press/)).toBeInTheDocument();
  });

  it("falls back to the plain chip when there is no week plan to show", () => {
    render(
      <ToolCallIndicator
        toolName="get_week_plan_details"
        state="output-available"
        output={{ found: false, message: "No week plan found for the current week." }}
      />,
    );

    expect(screen.queryByTestId("week-plan-card")).not.toBeInTheDocument();
    expect(screen.getByText("Loaded week plan")).toBeInTheDocument();
  });

  it("surfaces the tool's own error when program_week fails", () => {
    render(
      <ToolCallIndicator
        toolName="program_week"
        state="output-available"
        output={{ success: false, error: "No movements matched your constraints" }}
      />,
    );

    expect(screen.queryByTestId("week-plan-card")).not.toBeInTheDocument();
    expect(screen.getByText("No movements matched your constraints")).toBeInTheDocument();
  });

  it("still renders WeekPlanCard for program_week", () => {
    render(
      <ToolCallIndicator
        toolName="program_week"
        state="output-available"
        output={createProgramWeekOutput()}
      />,
    );

    expect(screen.getByTestId("week-plan-card")).toBeInTheDocument();
    expect(screen.getByText(/PPL split/)).toBeInTheDocument();
  });

  it.each(["durationSeconds", "duration"])(
    "preserves %s exercises from program_week output",
    (durationField) => {
      render(
        <ToolCallIndicator
          toolName="program_week"
          state="output-available"
          output={createProgramWeekOutput({
            days: [
              {
                ...validProgramWeekDay,
                exercises: [
                  {
                    name: "Plank",
                    muscleGroups: ["Core"],
                    sets: 3,
                    [durationField]: 45,
                  },
                ],
              },
            ],
          })}
        />,
      );

      expect(screen.getByText(/Plank duration:45 reps:none/)).toBeInTheDocument();
    },
  );

  it("returns null for unknown state", () => {
    const { container } = render(
      <ToolCallIndicator toolName="search_exercises" state="unknown-state" />,
    );

    expect(container.firstChild).toBeNull();
  });

  it.each([
    {
      name: "invalid calendar date",
      output: createProgramWeekOutput({ weekStartDate: "2026-02-30" }),
    },
    {
      name: "invalid split",
      output: createProgramWeekOutput({ preferredSplit: "invalid_split" }),
    },
    {
      name: "invalid day name",
      output: createProgramWeekOutput({ days: [{ ...validProgramWeekDay, dayName: "Funday" }] }),
    },
    {
      name: "mismatched day index",
      output: createProgramWeekOutput({ days: [{ ...validProgramWeekDay, dayIndex: 1 }] }),
    },
    {
      name: "invalid session type",
      output: createProgramWeekOutput({ days: [{ ...validProgramWeekDay, sessionType: "Push" }] }),
    },
    {
      name: "invalid session duration",
      output: createProgramWeekOutput({
        days: [{ ...validProgramWeekDay, estimatedDuration: 20 }],
      }),
    },
    {
      name: "zero training days",
      output: createProgramWeekOutput({ days: [] }),
    },
    {
      name: "malformed exercise",
      output: createProgramWeekOutput({
        days: [
          {
            ...validProgramWeekDay,
            exercises: [{ ...validProgramWeekDay.exercises[0], sets: "3" }],
          },
        ],
      }),
    },
    {
      name: "exercise with both reps and duration",
      output: createProgramWeekOutput({
        days: [
          {
            ...validProgramWeekDay,
            exercises: [{ ...validProgramWeekDay.exercises[0], durationSeconds: 45 }],
          },
        ],
      }),
    },
    {
      name: "exercise with neither reps nor duration",
      output: createProgramWeekOutput({
        days: [
          {
            ...validProgramWeekDay,
            exercises: [{ name: "Plank", muscleGroups: ["Core"], sets: 3 }],
          },
        ],
      }),
    },
  ])("shows an unconfirmed result for a $name", ({ output }) => {
    render(<ToolCallIndicator toolName="program_week" state="output-available" output={output} />);

    expect(screen.getByRole("status")).toHaveTextContent("This change could not be confirmed.");
    expect(screen.queryByTestId("week-plan-card")).not.toBeInTheDocument();
  });
});
