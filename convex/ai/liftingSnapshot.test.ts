import { describe, expect, test } from "vitest";
import type { LiftingSessionSnapshot } from "../liftingCoachProjection";
import { formatLiftingSnapshot } from "./liftingSnapshot";

function liftingSession(overrides: Partial<LiftingSessionSnapshot> = {}): LiftingSessionSnapshot {
  return {
    performedAt: new Date("2026-07-30T14:00:00.000Z").getTime(),
    calendarDate: "2026-07-30",
    title: "Garage Gym",
    durationMinutes: 45,
    exerciseCount: 1,
    setCount: 3,
    totalReps: 24,
    totalVolumeLbs: 3_600,
    exercises: [
      {
        name: "Barbell Squat",
        setCount: 3,
        totalReps: 24,
        totalVolumeLbs: 3_600,
      },
    ],
    ...overrides,
  };
}

describe("formatLiftingSnapshot", () => {
  test("formats bounded manual lifting summaries as non-Tonal fatigue context", () => {
    const section = formatLiftingSnapshot({
      sessions: [liftingSession()],
      now: new Date("2026-07-30T18:00:00.000Z"),
      userTimezone: "America/Denver",
    });

    expect(section?.priority).toBe(6);
    expect(section?.lines[0]).toBe("Manual Lifting (non-Tonal):");
    expect(section?.lines.join("\n")).toContain("[TODAY]");
    expect(section?.lines.join("\n")).toContain("Garage Gym | 45min | 1 exercise | 3 sets");
    expect(section?.lines.join("\n")).toContain("Barbell Squat | 3 sets | 24 reps | 3,600lbs vol");
    expect(section?.lines[section.lines.length - 1]).toBe(
      "  general fatigue/volume context only; do not treat as Tonal PR, Strength Score, or progressive-overload evidence.",
    );
    expect(section?.lines.join("\n")).not.toContain("RPE");
    expect(section?.lines.join("\n")).not.toContain("weight");
  });

  test("omits the manual lifting section when no sessions are available", () => {
    expect(
      formatLiftingSnapshot({
        sessions: [],
        now: new Date("2026-07-30T18:00:00.000Z"),
      }),
    ).toBeNull();
  });
});
