import { describe, expect, it } from "vitest";
import {
  isFailedProgramWeekOutput,
  isWeekPlanCardToolName,
  toWeekPlanPresentation,
  WEEK_PLAN_CARD_TOOL_NAMES,
} from "./weekPlanCardData";

function weekPlanDetailsOutput(
  overrides: Partial<{
    days: unknown[];
    preferredSplit: string;
  }> = {},
) {
  return {
    found: true,
    plan: {
      weekStartDate: "2026-08-03",
      preferredSplit: overrides.preferredSplit ?? "upper_lower",
      targetDays: 4,
      days: overrides.days ?? [
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
              muscleGroups: ["Chest", "Triceps"],
              sets: 3,
              reps: 10,
            },
            {
              movementId: "m2",
              name: "Seated Row",
              muscleGroups: ["Back"],
              sets: 3,
              reps: 10,
            },
          ],
        },
        {
          dayIndex: 4,
          dayName: "Friday",
          sessionType: "rest",
          status: "programmed",
          exercises: [],
        },
      ],
    },
  };
}

describe("toWeekPlanPresentation", () => {
  it("renders the current plan from get_week_plan_details", () => {
    const plan = toWeekPlanPresentation("get_week_plan_details", weekPlanDetailsOutput());

    expect(plan).not.toBeNull();
    expect(plan?.weekStartDate).toBe("2026-08-03");
    expect(plan?.split).toBe("upper_lower");
    expect(plan?.days).toHaveLength(1);
    expect(plan?.days[0].targetMuscles).toBe("Chest, Triceps, Back");
    expect(plan?.days[0].exercises.map((exercise) => exercise.name)).toEqual([
      "Standing Chest Press",
      "Seated Row",
    ]);
  });

  it("flags a draft plan as not yet pushed so the card cannot imply a completed push", () => {
    const plan = toWeekPlanPresentation("get_week_plan_details", weekPlanDetailsOutput());

    expect(plan?.summary).toContain("draft - not pushed yet");
  });

  it("reports a fully pushed plan in the summary", () => {
    const output = weekPlanDetailsOutput({
      days: [
        {
          dayIndex: 0,
          dayName: "Monday",
          sessionType: "upper",
          status: "pushed",
          estimatedDuration: 45,
          exercises: [
            { movementId: "m1", name: "Bench Press", muscleGroups: ["Chest"], sets: 3, reps: 8 },
          ],
        },
      ],
    });

    expect(toWeekPlanPresentation("get_week_plan_details", output)?.summary).toContain(
      "pushed to Tonal",
    );
  });

  it("defaults a missing estimatedDuration instead of failing the card", () => {
    const output = weekPlanDetailsOutput({
      days: [
        {
          dayIndex: 1,
          dayName: "Tuesday",
          sessionType: "lower",
          status: "draft",
          exercises: [
            { movementId: "m3", name: "Racked Squat", muscleGroups: ["Quads"], sets: 3, reps: 10 },
          ],
        },
      ],
    });

    expect(toWeekPlanPresentation("get_week_plan_details", output)?.days[0].durationMinutes).toBe(
      30,
    );
  });

  it("maps duration-based exercises through as seconds", () => {
    const output = weekPlanDetailsOutput({
      days: [
        {
          dayIndex: 0,
          dayName: "Monday",
          sessionType: "upper",
          status: "draft",
          estimatedDuration: 30,
          exercises: [
            {
              movementId: "m4",
              name: "Pillar Bridge Plank",
              muscleGroups: ["Abs"],
              sets: 3,
              durationSeconds: 30,
            },
          ],
        },
      ],
    });

    const exercise = toWeekPlanPresentation("get_week_plan_details", output)?.days[0].exercises[0];
    expect(exercise?.duration).toBe(30);
    expect(exercise?.reps).toBeUndefined();
  });

  it("returns null when the week has no plan", () => {
    expect(
      toWeekPlanPresentation("get_week_plan_details", {
        found: false,
        message: "No week plan found for the current week.",
      }),
    ).toBeNull();
  });

  it("returns null when every day is a rest day", () => {
    const output = weekPlanDetailsOutput({
      days: [
        {
          dayIndex: 5,
          dayName: "Saturday",
          sessionType: "rest",
          status: "programmed",
          exercises: [],
        },
      ],
    });

    expect(toWeekPlanPresentation("get_week_plan_details", output)).toBeNull();
  });

  it("still maps program_week output", () => {
    const plan = toWeekPlanPresentation("program_week", {
      success: true,
      summary: {
        weekStartDate: "2026-08-03",
        preferredSplit: "ppl",
        days: [
          {
            dayName: "Monday",
            sessionType: "push",
            estimatedDuration: 30,
            exercises: [
              {
                name: "Bench Press",
                muscleGroups: ["Chest"],
                sets: 3,
                reps: 8,
                suggestedTarget: "85 lbs",
              },
            ],
          },
        ],
      },
    });

    expect(plan?.days[0].exercises[0].note).toBe("85 lbs");
    expect(plan?.summary).toBe("PPL split - 1 training days");
  });

  it("returns null for a failed program_week payload", () => {
    const output = { success: false, error: "No movements matched" };

    expect(toWeekPlanPresentation("program_week", output)).toBeNull();
    expect(isFailedProgramWeekOutput(output)).toBe(true);
  });

  it("does not treat a malformed payload as an outright failure", () => {
    expect(isFailedProgramWeekOutput({ success: true, summary: null })).toBe(false);
    expect(isFailedProgramWeekOutput(undefined)).toBe(false);
  });
});

describe("isWeekPlanCardToolName", () => {
  it("accepts both card tools and rejects other week tools", () => {
    expect(WEEK_PLAN_CARD_TOOL_NAMES).toEqual(["program_week", "get_week_plan_details"]);
    expect(isWeekPlanCardToolName("get_week_plan_details")).toBe(true);
    expect(isWeekPlanCardToolName("rebuild_day")).toBe(false);
  });
});
