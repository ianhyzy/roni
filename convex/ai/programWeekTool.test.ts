import type { Id } from "../_generated/dataModel";
import type { DraftWeekSummary } from "../coach/weekProgrammingHelpers";
import { describe, expect, it } from "vitest";
import { projectProgramWeekSummary } from "./programWeekTool";

function draftSummary(days: DraftWeekSummary["days"]): DraftWeekSummary {
  return {
    weekStartDate: "2026-07-27",
    preferredSplit: "upper_lower",
    targetDays: days.length,
    sessionDurationMinutes: 45,
    days,
  };
}

describe("projectProgramWeekSummary", () => {
  it("preserves presentation fields while removing internal plan and movement IDs", () => {
    const input = draftSummary([
      {
        dayIndex: 0,
        dayName: "Monday",
        sessionType: "upper",
        workoutPlanId: "workout-plan-1" as Id<"workoutPlans">,
        estimatedDuration: 45,
        exercises: [
          {
            movementId: "movement-1",
            name: "Bench Press",
            muscleGroups: ["Chest", "Triceps"],
            sets: 3,
            reps: 8,
            lastTime: "3x8 at 80 lb",
            suggestedTarget: "Try 82 lb",
            lastWeight: 80,
            targetWeight: 82,
          },
          {
            movementId: "movement-2",
            name: "Plank",
            muscleGroups: ["Core"],
            sets: 3,
            durationSeconds: 45,
          },
        ],
      },
    ]);

    const result = projectProgramWeekSummary(input);

    expect(result).toEqual({
      weekStartDate: "2026-07-27",
      preferredSplit: "upper_lower",
      targetDays: 1,
      sessionDurationMinutes: 45,
      days: [
        {
          dayIndex: 0,
          dayName: "Monday",
          sessionType: "upper",
          estimatedDuration: 45,
          exercises: [
            {
              name: "Bench Press",
              muscleGroups: ["Chest", "Triceps"],
              sets: 3,
              reps: 8,
              lastTime: "3x8 at 80 lb",
              suggestedTarget: "Try 82 lb",
              lastWeight: 80,
              targetWeight: 82,
            },
            {
              name: "Plank",
              muscleGroups: ["Core"],
              sets: 3,
              durationSeconds: 45,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("workout-plan-1");
    expect(JSON.stringify(result)).not.toContain("movement-1");
    expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(input).length);
  });

  it("returns an empty days collection without inventing plan data", () => {
    const input = draftSummary([]);

    const result = projectProgramWeekSummary(input);

    expect(result.days).toEqual([]);
  });
});
