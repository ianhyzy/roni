import { describe, expect, it } from "vitest";
import {
  canonicalPersonalMrvMuscleGroup,
  estimatePersonalMrv,
  MIN_MRV_HALF_OBSERVATIONS,
  type SetStrengthObservation,
} from "./personalMrv";

function week(index: number): string {
  const date = new Date("2026-01-05T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + index * 7);
  return date.toISOString().slice(0, 10);
}

function stableSeries(trainingCap = 11, validationCap = 11): SetStrengthObservation[] {
  return Array.from({ length: 24 }, (_, index) => {
    const halfIndex = index % 12;
    const cap = index < 12 ? trainingCap : validationCap;
    const weeklySets = halfIndex < 6 ? cap - 3 + (halfIndex % 3) : cap + 3 + (halfIndex % 3);
    return {
      week: week(index),
      weeklySets,
      strengthChange: halfIndex < 6 ? 2 : -2,
    };
  });
}

describe("estimatePersonalMrv", () => {
  it("qualifies a stable adverse high-volume threshold across chronological halves", () => {
    const result = estimatePersonalMrv(stableSeries(), { min: 10, max: 20 });

    expect(result).toEqual({
      status: "qualified_for_enforcement",
      pairedObservationCount: 24,
      maxWeeklySets: 10,
      literatureMinWeeklySets: 10,
      literatureMaxWeeklySets: 20,
      training: {
        capWeeklySets: 10,
        atOrBelowCount: 6,
        aboveCount: 6,
        atOrBelowMedianStrengthChange: 2,
        aboveMedianStrengthChange: -2,
        cliffsDelta: 1,
      },
      validation: {
        capWeeklySets: 10,
        atOrBelowCount: 6,
        aboveCount: 6,
        atOrBelowMedianStrengthChange: 2,
        aboveMedianStrengthChange: -2,
        cliffsDelta: 1,
      },
    });
  });

  it("fails closed when either chronological half is too small", () => {
    const rows = stableSeries().slice(0, MIN_MRV_HALF_OBSERVATIONS * 2 - 1);

    expect(estimatePersonalMrv(rows, { min: 10, max: 20 })).toEqual({
      status: "insufficient_data",
      pairedObservationCount: 23,
      reason: "not_enough_non_overlapping_history",
    });
  });

  it("keeps independently fitted thresholds advisory when they are unstable", () => {
    const result = estimatePersonalMrv(stableSeries(9, 18), { min: 8, max: 20 });

    expect(result).toEqual(
      expect.objectContaining({
        status: "advisory_only",
        pairedObservationCount: 24,
        reason: "unstable_threshold",
        training: expect.objectContaining({ capWeeklySets: 8 }),
        validation: expect.objectContaining({ capWeeklySets: 17 }),
      }),
    );
  });

  it("rejects a threshold when higher-volume weeks do not decline", () => {
    const rows = stableSeries().map((row) => ({ ...row, strengthChange: 1 }));

    expect(estimatePersonalMrv(rows, { min: 10, max: 20 })).toEqual({
      status: "advisory_only",
      pairedObservationCount: 24,
      reason: "no_training_threshold",
    });
  });

  it("keeps thresholds advisory when lower-volume weeks also lose strength", () => {
    const rows = stableSeries().map((row) => ({
      ...row,
      strengthChange: row.strengthChange > 0 ? -1 : -2,
    }));

    expect(estimatePersonalMrv(rows, { min: 10, max: 20 })).toEqual({
      status: "advisory_only",
      pairedObservationCount: 24,
      reason: "no_training_threshold",
    });
  });

  it("keeps a training threshold advisory when the later half does not reproduce it", () => {
    const rows = stableSeries().map((row, index) =>
      index < 12 ? row : { ...row, strengthChange: 1 },
    );

    expect(estimatePersonalMrv(rows, { min: 10, max: 20 })).toEqual(
      expect.objectContaining({
        status: "advisory_only",
        pairedObservationCount: 24,
        reason: "no_validation_threshold",
        training: expect.objectContaining({ capWeeklySets: 10 }),
      }),
    );
  });

  it("ignores invalid observations before making the chronological split", () => {
    const rows = [
      ...stableSeries(),
      { week: week(24), weeklySets: Number.NaN, strengthChange: -2 },
      { week: week(25), weeklySets: -1, strengthChange: -2 },
      { week: week(26), weeklySets: 20, strengthChange: Number.POSITIVE_INFINITY },
    ];

    expect(estimatePersonalMrv(rows, { min: 10, max: 20 })).toEqual(
      expect.objectContaining({
        status: "qualified_for_enforcement",
        pairedObservationCount: 24,
        maxWeeklySets: 10,
      }),
    );
  });

  it("caps a qualified estimate at the literature maximum", () => {
    const result = estimatePersonalMrv(stableSeries(23, 23), { min: 8, max: 16 });

    expect(result).toEqual(
      expect.objectContaining({
        status: "qualified_for_enforcement",
        maxWeeklySets: 16,
        literatureMinWeeklySets: 8,
        literatureMaxWeeklySets: 16,
      }),
    );
  });

  it("keeps a stable threshold advisory when it falls below minimum viable volume", () => {
    const result = estimatePersonalMrv(stableSeries(6, 6), { min: 10, max: 20 });

    expect(result).toEqual(
      expect.objectContaining({
        status: "advisory_only",
        reason: "threshold_below_literature_minimum",
        training: expect.objectContaining({ capWeeklySets: 5 }),
        validation: expect.objectContaining({ capWeeklySets: 5 }),
      }),
    );
  });
});

describe("canonicalPersonalMrvMuscleGroup", () => {
  it("normalizes supported catalog aliases and rejects untracked groups", () => {
    expect(canonicalPersonalMrvMuscleGroup(" quadriceps ")).toBe("Quads");
    expect(canonicalPersonalMrvMuscleGroup("TRICEP")).toBe("Triceps");
    expect(canonicalPersonalMrvMuscleGroup("Obliques")).toBeNull();
  });
});
