import { describe, expect, test } from "vitest";
import type { RecoveryState } from "../trainingState/types";
import { formatRecoveryLines } from "./recoverySnapshot";

function recoveryState(overrides: Partial<RecoveryState> = {}): RecoveryState {
  return {
    status: "caution",
    confidence: "high",
    source: "garmin",
    observedDate: "2026-07-30",
    reasons: ["short_sleep", "low_energy"],
    metrics: { sleepHours: 5.5, hrvMilliseconds: 41, energy: 2, soreness: 4, stress: 3 },
    checkIn: {
      calendarDate: "2026-07-30",
      energy: 2,
      soreness: 4,
      stress: 3,
      notes: "Heavy legs",
      updatedAt: 1,
    },
    history: [
      {
        source: "garmin",
        calendarDate: "2026-07-30",
        ingestedAt: 1,
        sleepDurationSeconds: 19_800,
        hrvMilliseconds: 41,
      },
    ],
    ...overrides,
  };
}

describe("formatRecoveryLines", () => {
  test("formats one provider section with selected metrics, check-in, and advisory caution", () => {
    const lines = formatRecoveryLines(recoveryState());

    expect(lines[0]).toBe("Recovery Signals (Garmin) — caution, high confidence:");
    expect(lines).toContain("  Current | sleep 5.5h | HRV 41ms");
    expect(lines).toContain(
      "  Check-in | energy 2/5 | soreness 4/5 | stress 3/5 | notes Heavy legs",
    );
    expect(lines).toContain("  Caution: short sleep; low energy");
    expect(lines[lines.length - 1]).toContain("not a medical diagnosis");
  });

  test("formats manual-only recovery without provider history", () => {
    const lines = formatRecoveryLines(
      recoveryState({
        status: "normal",
        confidence: "low",
        source: "manual",
        reasons: [],
        metrics: { energy: 4, soreness: 2, stress: 2 },
        history: [],
      }),
    );

    expect(lines[0]).toBe("Recovery Signals (Manual) — normal, low confidence:");
    expect(lines.some((line) => line.includes("Garmin"))).toBe(false);
  });

  test("omits an unknown state with no fresh recovery signal", () => {
    expect(
      formatRecoveryLines(
        recoveryState({
          status: "unknown",
          confidence: "low",
          source: null,
          observedDate: null,
          reasons: ["no_fresh_data"],
          metrics: {},
          checkIn: null,
        }),
      ),
    ).toEqual([]);
  });
});
