import { describe, expect, it } from "vitest";
import type { RecoveryInputs, RecoveryObservation } from "./types";
import { deriveRecoveryState } from "./recovery";

const NOW = Date.parse("2026-07-30T18:00:00.000Z");
const CURRENT_DATE = "2026-07-30";

function observation(
  source: "garmin" | "fitbit",
  overrides: Partial<RecoveryObservation> = {},
): RecoveryObservation {
  return {
    source,
    calendarDate: CURRENT_DATE,
    ingestedAt: NOW - 60_000,
    sleepDurationSeconds: 7 * 60 * 60,
    ...overrides,
  };
}

function inputs(overrides: Partial<RecoveryInputs> = {}): RecoveryInputs {
  return {
    preferredSource: null,
    observations: [],
    checkIns: [],
    ...overrides,
  };
}

describe("deriveRecoveryState", () => {
  it("uses only the preferred provider when both providers have fresh observations", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        preferredSource: "garmin",
        observations: [
          observation("garmin", { sleepDurationSeconds: 5.5 * 60 * 60 }),
          observation("fitbit", {
            ingestedAt: NOW,
            sleepDurationSeconds: 8 * 60 * 60,
          }),
        ],
      }),
    });

    expect(state.source).toBe("garmin");
    expect(state.status).toBe("caution");
    expect(state.reasons).toEqual(["short_sleep"]);
    expect(state.history.map((row) => row.source)).toEqual(["garmin"]);
  });

  it("selects the freshest provider and breaks exact ties in Garmin's favor", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        observations: [
          observation("fitbit", { restingHeartRate: 54 }),
          observation("garmin", { calendarDate: "2026-07-29", restingHeartRate: 58 }),
        ],
      }),
    });

    expect(state.source).toBe("garmin");
    expect(state.metrics.restingHeartRate).toBe(58);
    expect(state.history.map((row) => row.source)).toEqual(["garmin"]);
  });

  it("uses ingestion age for provider freshness even when the observation date is older", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        observations: [
          observation("fitbit", {
            calendarDate: "2026-07-27",
            ingestedAt: NOW - 60_000,
          }),
        ],
      }),
    });

    expect(state.source).toBe("fitbit");
    expect(state.status).toBe("normal");
  });

  it("falls back when the preferred provider is stale and another provider is fresh", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        preferredSource: "garmin",
        observations: [
          observation("garmin", {
            calendarDate: "2026-07-28",
            ingestedAt: NOW - 37 * 60 * 60 * 1000,
          }),
          observation("fitbit", { restingHeartRate: 52 }),
        ],
      }),
    });

    expect(state.source).toBe("fitbit");
    expect(state.metrics.restingHeartRate).toBe(52);
    expect(state.history.map((row) => row.source)).toEqual(["fitbit"]);
  });

  it("combines a fresh provider observation with a fresh subjective check-in", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        observations: [observation("fitbit")],
        checkIns: [
          {
            calendarDate: CURRENT_DATE,
            energy: 2,
            soreness: 4,
            stress: 3,
            notes: "Heavy legs",
            updatedAt: NOW,
          },
        ],
      }),
    });

    expect(state.source).toBe("fitbit");
    expect(state.confidence).toBe("high");
    expect(state.status).toBe("caution");
    expect(state.reasons).toEqual(["low_energy", "high_soreness"]);
    expect(state.metrics).toMatchObject({ energy: 2, soreness: 4, stress: 3 });
    expect(state.checkIn?.notes).toBe("Heavy legs");
  });

  it("returns a low-confidence manual state when only a fresh check-in exists", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        checkIns: [
          {
            calendarDate: CURRENT_DATE,
            energy: 4,
            soreness: 2,
            stress: 2,
            updatedAt: NOW,
          },
        ],
      }),
    });

    expect(state).toMatchObject({
      status: "normal",
      confidence: "low",
      source: "manual",
      observedDate: CURRENT_DATE,
      reasons: [],
    });
  });

  it("returns unknown when provider and subjective signals are stale", () => {
    const staleAt = NOW - 37 * 60 * 60 * 1000;
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        observations: [
          observation("garmin", {
            calendarDate: "2026-07-28",
            ingestedAt: staleAt,
          }),
        ],
        checkIns: [
          {
            calendarDate: "2026-07-28",
            energy: 1,
            soreness: 5,
            stress: 5,
            updatedAt: staleAt,
          },
        ],
      }),
    });

    expect(state).toMatchObject({
      status: "unknown",
      confidence: "low",
      source: null,
      observedDate: null,
      reasons: ["no_fresh_data"],
    });
    expect(state.metrics).toEqual({});
  });

  it("treats the exact 36-hour freshness boundary as fresh", () => {
    const atBoundary = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        observations: [
          observation("fitbit", {
            calendarDate: "2026-07-29",
            ingestedAt: NOW - 36 * 60 * 60 * 1000,
          }),
        ],
      }),
    });
    const beyondBoundary = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        observations: [
          observation("fitbit", {
            calendarDate: "2026-07-29",
            ingestedAt: NOW - 36 * 60 * 60 * 1000 - 1,
          }),
        ],
      }),
    });

    expect(atBoundary.source).toBe("fitbit");
    expect(atBoundary.status).toBe("normal");
    expect(beyondBoundary.status).toBe("unknown");
  });

  it("accepts a provider timestamp exactly five minutes in the future", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        observations: [observation("fitbit", { ingestedAt: NOW + 5 * 60 * 1000 })],
      }),
    });

    expect(state.source).toBe("fitbit");
    expect(state.status).toBe("normal");
  });

  it("rejects a provider timestamp more than five minutes in the future", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        observations: [observation("fitbit", { ingestedAt: NOW + 5 * 60 * 1000 + 1 })],
      }),
    });

    expect(state.source).toBeNull();
    expect(state.status).toBe("unknown");
  });

  it("never selects a check-in from a future local calendar date", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        checkIns: [
          {
            calendarDate: "2026-07-31",
            energy: 1,
            soreness: 5,
            stress: 5,
            updatedAt: NOW,
          },
          {
            calendarDate: CURRENT_DATE,
            energy: 4,
            soreness: 2,
            stress: 2,
            updatedAt: NOW - 1,
          },
        ],
      }),
    });

    expect(state.observedDate).toBe(CURRENT_DATE);
    expect(state.metrics).toMatchObject({ energy: 4, soreness: 2, stress: 2 });
  });

  it("uses Garmin status and body battery flags without inventing a Fitbit HRV threshold", () => {
    const garmin = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        observations: [
          observation("garmin", {
            hrvStatus: "low",
            bodyBatteryHighestValue: 29,
          }),
        ],
      }),
    });
    const fitbit = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        observations: [observation("fitbit", { hrvMilliseconds: 18 })],
      }),
    });

    expect(garmin.status).toBe("caution");
    expect(garmin.reasons).toEqual(["low_hrv_status", "low_body_battery"]);
    expect(fitbit.status).toBe("normal");
    expect(fitbit.reasons).toEqual([]);
  });

  it("keeps exact caution thresholds in the normal state", () => {
    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({
        observations: [
          observation("garmin", {
            sleepDurationSeconds: 6 * 60 * 60,
            bodyBatteryHighestValue: 30,
          }),
        ],
        checkIns: [
          {
            calendarDate: CURRENT_DATE,
            energy: 3,
            soreness: 3,
            stress: 5,
            updatedAt: NOW,
          },
        ],
      }),
    });

    expect(state.status).toBe("normal");
    expect(state.reasons).toEqual([]);
  });

  it("keeps at most seven history rows from the selected provider", () => {
    const observations = Array.from({ length: 10 }, (_, index) =>
      observation("garmin", {
        calendarDate: `2026-07-${String(30 - index).padStart(2, "0")}`,
        ingestedAt: NOW - index * 60_000,
      }),
    );
    observations.push(observation("fitbit"));

    const state = deriveRecoveryState({
      now: NOW,
      currentCalendarDate: CURRENT_DATE,
      inputs: inputs({ preferredSource: "garmin", observations }),
    });

    expect(state.history).toHaveLength(7);
    expect(state.history.every((row) => row.source === "garmin")).toBe(true);
    expect(state.history[0]?.calendarDate).toBe(CURRENT_DATE);
  });
});
