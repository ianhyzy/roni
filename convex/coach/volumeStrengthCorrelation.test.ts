import { describe, expect, it } from "vitest";
import {
  analyzeVolumeStrength,
  MIN_PAIRED_OBSERVATIONS,
  type VolumeStrengthAnalysisInput,
} from "./volumeStrengthCorrelation";

function input(overrides: Partial<VolumeStrengthAnalysisInput> = {}): VolumeStrengthAnalysisInput {
  return {
    windowStartDate: "2026-01-05",
    windowEndDate: "2026-07-05",
    performanceRows: [],
    strengthSnapshots: [],
    movements: [],
    ...overrides,
  };
}

function utcDate(weekOffset: number): string {
  const date = new Date("2026-01-05T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + weekOffset * 7);
  return date.toISOString().slice(0, 10);
}

function upperSeries(volumes: readonly number[], strengthChanges: readonly number[]) {
  let upper = 100;
  const strengthSnapshots = [
    { date: utcDate(-1), upper, lower: 100, core: 100 },
    ...strengthChanges.map((change, index) => {
      upper += change;
      return { date: utcDate(index), upper, lower: 100, core: 100 };
    }),
  ];
  return input({
    windowEndDate: utcDate(volumes.length - 1),
    movements: [{ tonalId: "bench", bodyRegion: "upper", muscleGroups: ["Chest"] }],
    performanceRows: volumes.map((totalVolume, index) => ({
      movementId: "bench",
      date: utcDate(index),
      totalVolume,
    })),
    strengthSnapshots,
  });
}

describe("analyzeVolumeStrength", () => {
  it("returns insufficient data for every region when there are no observations", () => {
    const result = analyzeVolumeStrength(input());

    expect(MIN_PAIRED_OBSERVATIONS).toBeGreaterThanOrEqual(6);
    expect(result.windowWeeks).toBe(26);
    expect(result.regions).toEqual([
      {
        status: "insufficient_data",
        region: "upper",
        weeklyObservationCount: 0,
        strengthObservationCount: 0,
        unmappedMovementCount: 0,
      },
      {
        status: "insufficient_data",
        region: "lower",
        weeklyObservationCount: 0,
        strengthObservationCount: 0,
        unmappedMovementCount: 0,
      },
      {
        status: "insufficient_data",
        region: "core",
        weeklyObservationCount: 0,
        strengthObservationCount: 0,
        unmappedMovementCount: 0,
      },
    ]);
    expect(result.caveat).toContain("observational correlation");
    expect(result.caveat).toContain("not causal MRV");
    expect(result.caveat).toContain("hard cap");
  });

  it("aggregates mapped movement volume by UTC week and reports distinct unmapped movements", () => {
    const result = analyzeVolumeStrength(
      input({
        movements: [
          { tonalId: "bench", bodyRegion: "Upper Body", muscleGroups: ["Chest"] },
          { tonalId: "squat", muscleGroups: ["Quads", "Glutes"] },
          { tonalId: "plank", muscleGroups: ["Abs", "Obliques"] },
          { tonalId: "mixed", muscleGroups: ["Chest", "Quads"] },
        ],
        performanceRows: [
          { movementId: "bench", date: "2026-01-05", totalVolume: 100 },
          { movementId: "bench", date: "2026-01-11", totalVolume: 150 },
          { movementId: "bench", date: "2026-01-12", totalVolume: 200 },
          { movementId: "squat", date: "2026-01-06", totalVolume: 300 },
          { movementId: "plank", date: "2026-01-07", totalVolume: 40 },
          { movementId: "mixed", date: "2026-01-19", totalVolume: 50 },
          { movementId: "missing", date: "2026-01-20", totalVolume: 60 },
          { movementId: "missing", date: "2026-01-21", totalVolume: 70 },
          { movementId: "bench", date: "2026-01-04", totalVolume: 999 },
        ],
      }),
    );

    expect(result.regions).toEqual([
      expect.objectContaining({
        region: "upper",
        weeklyObservationCount: 2,
        unmappedMovementCount: 2,
      }),
      expect.objectContaining({
        region: "lower",
        weeklyObservationCount: 1,
        unmappedMovementCount: 2,
      }),
      expect.objectContaining({
        region: "core",
        weeklyObservationCount: 1,
        unmappedMovementCount: 2,
      }),
    ]);
  });

  it("counts strength changes only between consecutive weekly observations", () => {
    const result = analyzeVolumeStrength(
      input({
        strengthSnapshots: [
          { date: "2025-12-31", upper: 100, lower: 80, core: 60 },
          { date: "2026-01-05", upper: 101, lower: 81, core: 61 },
          { date: "2026-01-11", upper: 102, lower: 82, core: 62 },
          { date: "2026-01-18", upper: 106, lower: 84, core: 63 },
          { date: "2026-01-26", upper: 110, lower: 86, core: 64 },
        ],
      }),
    );

    expect(result.regions).toEqual([
      expect.objectContaining({
        status: "insufficient_data",
        region: "upper",
        strengthObservationCount: 2,
      }),
      expect.objectContaining({
        status: "insufficient_data",
        region: "lower",
        strengthObservationCount: 2,
      }),
      expect.objectContaining({
        status: "insufficient_data",
        region: "core",
        strengthObservationCount: 2,
      }),
    ]);
  });

  it("returns a low-confidence provisional positive correlation with deterministic tie ranks", () => {
    const result = analyzeVolumeStrength(
      upperSeries([100, 100, 200, 200, 300, 300, 400, 400], [1, 1, 2, 2, 3, 3, 4, 4]),
    );

    expect(result.regions[0]).toEqual({
      status: "provisional",
      region: "upper",
      weeklyObservationCount: 8,
      strengthObservationCount: 8,
      unmappedMovementCount: 0,
      pairedObservationCount: 8,
      latestPairedWeek: utcDate(7),
      daysSinceLatestPairedWeek: 0,
      spearmanRho: 1,
      direction: "positive",
      confidence: "low",
      programmingEligibility: {
        status: "advisory_only",
        reasons: ["low_confidence", "no_negative_relationship"],
      },
      volumeRange: { minWeeklyVolume: 100, maxWeeklyVolume: 400 },
    });
  });

  it("requires the conservative minimum number of paired weekly observations", () => {
    const result = analyzeVolumeStrength(
      upperSeries([100, 200, 300, 400, 500, 600, 700], [1, 2, 3, 4, 5, 6, 7]),
    );

    expect(result.regions[0]).toEqual({
      status: "insufficient_data",
      region: "upper",
      weeklyObservationCount: MIN_PAIRED_OBSERVATIONS - 1,
      strengthObservationCount: MIN_PAIRED_OBSERVATIONS - 1,
      unmappedMovementCount: 0,
    });
  });

  it("returns medium confidence for a negative correlation with sixteen paired weeks", () => {
    const volumes = Array.from({ length: 16 }, (_, index) => index + 1);
    const strengthChanges = Array.from({ length: 16 }, (_, index) => 16 - index);

    const result = analyzeVolumeStrength(upperSeries(volumes, strengthChanges));

    expect(result.regions[0]).toEqual(
      expect.objectContaining({
        status: "provisional",
        spearmanRho: -1,
        direction: "negative",
        confidence: "medium",
        pairedObservationCount: 16,
        latestPairedWeek: utcDate(15),
        daysSinceLatestPairedWeek: 0,
        programmingEligibility: {
          status: "eligible_for_mrv_estimation",
          reasons: [],
        },
      }),
    );
  });

  it("keeps an otherwise eligible relationship advisory-only when observations are stale", () => {
    const volumes = Array.from({ length: 16 }, (_, index) => index + 1);
    const strengthChanges = Array.from({ length: 16 }, (_, index) => 16 - index);
    const series = upperSeries(volumes, strengthChanges);

    const result = analyzeVolumeStrength({ ...series, windowEndDate: utcDate(20) });

    expect(result.regions[0]).toEqual(
      expect.objectContaining({
        status: "provisional",
        confidence: "medium",
        direction: "negative",
        daysSinceLatestPairedWeek: 35,
        programmingEligibility: {
          status: "advisory_only",
          reasons: ["stale_observations"],
        },
      }),
    );
  });

  it("keeps a fresh medium-confidence positive relationship advisory-only", () => {
    const volumes = Array.from({ length: 16 }, (_, index) => index + 1);
    const strengthChanges = Array.from({ length: 16 }, (_, index) => index + 1);

    const result = analyzeVolumeStrength(upperSeries(volumes, strengthChanges));

    expect(result.regions[0]).toEqual(
      expect.objectContaining({
        status: "provisional",
        confidence: "medium",
        direction: "positive",
        programmingEligibility: {
          status: "advisory_only",
          reasons: ["no_negative_relationship"],
        },
      }),
    );
  });

  it("keeps a fresh negative relationship advisory-only when movements are unmapped", () => {
    const volumes = Array.from({ length: 17 }, (_, index) => index + 1);
    const strengthChanges = Array.from({ length: 17 }, (_, index) => 17 - index);
    const series = upperSeries(volumes, strengthChanges);

    const result = analyzeVolumeStrength({
      ...series,
      performanceRows: [
        ...series.performanceRows,
        { movementId: "unknown", date: utcDate(0), totalVolume: 100 },
      ],
    });

    expect(result.regions[0]).toEqual(
      expect.objectContaining({
        status: "provisional",
        pairedObservationCount: 16,
        confidence: "medium",
        direction: "negative",
        unmappedMovementCount: 1,
        programmingEligibility: {
          status: "advisory_only",
          reasons: ["unmapped_movements"],
        },
      }),
    );
  });

  it("labels a near-zero rank relationship as flat", () => {
    const result = analyzeVolumeStrength(
      upperSeries([1, 2, 3, 4, 5, 6, 7, 8], [4, 2, 8, 3, 5, 7, 6, 1]),
    );

    expect(result.regions[0]).toEqual(
      expect.objectContaining({
        status: "provisional",
        spearmanRho: -0.024,
        direction: "flat",
      }),
    );
  });

  it("returns insufficient data when paired observations have no rank variance", () => {
    const result = analyzeVolumeStrength(
      upperSeries([100, 100, 100, 100, 100, 100, 100, 100], [1, 2, 3, 4, 5, 6, 7, 8]),
    );

    expect(result.regions[0]).toEqual({
      status: "insufficient_data",
      region: "upper",
      weeklyObservationCount: 8,
      strengthObservationCount: 8,
      unmappedMovementCount: 0,
    });
  });
});
