import { describe, expect, it } from "vitest";
import {
  analyzeVolumeStrength,
  type VolumeStrengthAnalysisInput,
} from "./volumeStrengthCorrelation";

function input(overrides: Partial<VolumeStrengthAnalysisInput> = {}): VolumeStrengthAnalysisInput {
  return {
    windowStartDate: "2026-01-05",
    windowEndDate: "2026-07-05",
    performanceRows: [],
    strengthSnapshots: [],
    movements: [],
    completedWorkouts: [],
    ...overrides,
  };
}

function utcDate(weekOffset: number): string {
  const date = new Date("2026-01-05T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + weekOffset * 7);
  return date.toISOString().slice(0, 10);
}

function utcDateInWeek(weekOffset: number, dayOffset: number): string {
  const date = new Date(`${utcDate(weekOffset)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return date.toISOString().slice(0, 10);
}

function upperSeries(): VolumeStrengthAnalysisInput {
  let upper = 100;
  return input({
    windowEndDate: utcDate(7),
    movements: [{ tonalId: "bench", bodyRegion: "upper", muscleGroups: ["Chest"] }],
    performanceRows: Array.from({ length: 8 }, (_, index) => ({
      movementId: "bench",
      date: utcDate(index),
      totalVolume: (index + 1) * 100,
    })),
    strengthSnapshots: [
      { date: utcDate(-1), upper, lower: 100, core: 100 },
      ...Array.from({ length: 8 }, (_, index) => {
        upper += index + 1;
        return { date: utcDate(index), upper, lower: 100, core: 100 };
      }),
    ],
  });
}

describe("analyzeVolumeStrength data quality", () => {
  it("includes zero-volume weeks for regions with consecutive strength observations", () => {
    const result = analyzeVolumeStrength(upperSeries());

    expect(result.regions[1]).toEqual({
      status: "insufficient_data",
      region: "lower",
      weeklyObservationCount: 8,
      strengthObservationCount: 8,
      unmappedMovementCount: 0,
    });
    expect(result.regions[2]).toEqual({
      status: "insufficient_data",
      region: "core",
      weeklyObservationCount: 8,
      strengthObservationCount: 8,
      unmappedMovementCount: 0,
    });
  });

  it("excludes weeks with missing mapped volume instead of treating them as zero", () => {
    const series = upperSeries();
    const result = analyzeVolumeStrength({
      ...series,
      performanceRows: Array.from({ length: 8 }, (_, index) => ({
        movementId: "bench",
        date: utcDate(index),
      })),
    });

    expect(result.regions[0]).toEqual({
      status: "insufficient_data",
      region: "upper",
      weeklyObservationCount: 0,
      strengthObservationCount: 8,
      unmappedMovementCount: 0,
    });
    expect(result.caveat).toContain("missing or unmapped volume data");
  });

  it("excludes a partially measured regional week when one mapped row lacks volume", () => {
    const series = upperSeries();
    const result = analyzeVolumeStrength({
      ...series,
      movements: [
        ...series.movements,
        { tonalId: "press", bodyRegion: "upper", muscleGroups: ["Shoulders"] },
      ],
      performanceRows: series.performanceRows.flatMap((row) => [
        row,
        { movementId: "press", date: row.date },
      ]),
    });

    expect(result.regions[0]).toEqual(
      expect.objectContaining({ status: "insufficient_data", weeklyObservationCount: 0 }),
    );
  });

  it("excludes unmapped-volume weeks from every regional pairing", () => {
    const series = upperSeries();
    const result = analyzeVolumeStrength({
      ...series,
      performanceRows: Array.from({ length: 8 }, (_, index) => ({
        movementId: "unknown",
        date: utcDate(index),
        totalVolume: 100,
      })),
    });

    expect(result.regions).toEqual([
      expect.objectContaining({ region: "upper", weeklyObservationCount: 0 }),
      expect.objectContaining({ region: "lower", weeklyObservationCount: 0 }),
      expect.objectContaining({ region: "core", weeklyObservationCount: 0 }),
    ]);
  });

  it("uses the latest strength snapshot within each UTC week", () => {
    const volumes = Array.from({ length: 8 }, (_, index) => (index + 1) * 100);
    let latestUpper = 100;
    const strengthSnapshots = [
      { date: utcDateInWeek(-1, 6), upper: latestUpper, lower: 100, core: 100 },
    ];
    for (let index = 0; index < volumes.length; index++) {
      strengthSnapshots.push({
        date: utcDateInWeek(index, 0),
        upper: 1_000 - index,
        lower: 100,
        core: 100,
      });
      latestUpper += index + 1;
      strengthSnapshots.push({
        date: utcDateInWeek(index, 6),
        upper: latestUpper,
        lower: 100,
        core: 100,
      });
    }

    const result = analyzeVolumeStrength(
      input({
        windowEndDate: utcDateInWeek(7, 6),
        movements: [{ tonalId: "bench", bodyRegion: "upper", muscleGroups: ["Chest"] }],
        performanceRows: volumes.map((totalVolume, index) => ({
          movementId: "bench",
          date: utcDate(index),
          totalVolume,
        })),
        strengthSnapshots,
      }),
    );

    expect(result.regions[0]).toEqual(
      expect.objectContaining({
        status: "provisional",
        weeklyObservationCount: 8,
        strengthObservationCount: 8,
        spearmanRho: 1,
      }),
    );
  });

  it("excludes missing, negative, and non-finite volume observations", () => {
    const result = analyzeVolumeStrength(
      input({
        movements: [{ tonalId: "bench", bodyRegion: "upper", muscleGroups: ["Chest"] }],
        performanceRows: [
          { movementId: "bench", date: "2026-01-05" },
          { movementId: "bench", date: "2026-01-12", totalVolume: -1 },
          { movementId: "bench", date: "2026-01-19", totalVolume: Number.NaN },
          { movementId: "bench", date: "2026-01-26", totalVolume: Number.POSITIVE_INFINITY },
        ],
      }),
    );

    expect(result.regions[0]).toEqual({
      status: "insufficient_data",
      region: "upper",
      weeklyObservationCount: 0,
      strengthObservationCount: 0,
      unmappedMovementCount: 0,
    });
  });

  it("fails set-based estimates closed when historical set counts are missing", () => {
    let upper = 100;
    const strengthSnapshots = [
      { date: utcDate(-1), upper, lower: 100, core: 100 },
      ...Array.from({ length: 24 }, (_, index) => {
        upper += index % 12 < 6 ? 2 : -2;
        return { date: utcDate(index), upper, lower: 100, core: 100 };
      }),
    ];

    const result = analyzeVolumeStrength(
      input({
        windowEndDate: utcDate(23),
        movements: [{ tonalId: "bench", bodyRegion: "upper", muscleGroups: ["Chest"] }],
        performanceRows: Array.from({ length: 24 }, (_, index) => ({
          movementId: "bench",
          date: utcDate(index),
          totalVolume: (index + 1) * 100,
        })),
        strengthSnapshots,
      }),
    );

    expect(result.personalMrvEstimates).toEqual([
      {
        muscleGroup: "Chest",
        region: "upper",
        status: "insufficient_data",
        pairedObservationCount: 0,
        reason: "not_enough_non_overlapping_history",
      },
    ]);
  });

  it("excludes weeks whose completed workouts have incomplete performance projections", () => {
    const incompleteWeeks = new Set([0, 1, 2, 3, 13, 14, 15, 16]);
    const lowVolumeWeeks = new Set([4, 5, 17, 18]);
    let upper = 100;
    const strengthSnapshots = [
      { date: utcDate(-1), upper, lower: 100, core: 100 },
      ...Array.from({ length: 26 }, (_, index) => {
        upper += incompleteWeeks.has(index) || lowVolumeWeeks.has(index) ? 2 : -2;
        return { date: utcDate(index), upper, lower: 100, core: 100 };
      }),
    ];
    const performanceRows = Array.from({ length: 26 }, (_, index) => index)
      .filter((index) => !incompleteWeeks.has(index))
      .map((index) => ({
        movementId: "bench",
        date: utcDate(index),
        sets: lowVolumeWeeks.has(index) ? 10 : 15,
        totalVolume: lowVolumeWeeks.has(index) ? 1_000 : 1_500,
      }));

    const result = analyzeVolumeStrength({
      ...input({
        windowEndDate: utcDate(25),
        movements: [{ tonalId: "bench", bodyRegion: "upper", muscleGroups: ["Chest"] }],
        performanceRows,
        strengthSnapshots,
      }),
      completedWorkouts: Array.from({ length: 26 }, (_, index) => ({
        date: utcDate(index),
        ...(incompleteWeeks.has(index) ? {} : { performanceSyncComplete: true as const }),
      })),
    });

    expect(result.personalMrvEstimates).toEqual([
      {
        muscleGroup: "Chest",
        region: "upper",
        status: "insufficient_data",
        pairedObservationCount: 18,
        reason: "not_enough_non_overlapping_history",
      },
    ]);
  });

  it("excludes weeks containing unmapped movements from every observed muscle estimate", () => {
    let upper = 100;
    const strengthSnapshots = [
      { date: utcDate(-1), upper, lower: 100, core: 100 },
      ...Array.from({ length: 24 }, (_, index) => {
        upper += index % 12 < 6 ? 2 : -2;
        return { date: utcDate(index), upper, lower: 100, core: 100 };
      }),
    ];
    const performanceRows = Array.from({ length: 24 }, (_, index) => ({
      movementId: "bench",
      date: utcDate(index),
      sets: index % 12 < 6 ? 8 : 14,
      totalVolume: index % 12 < 6 ? 800 : 1_400,
    }));

    const result = analyzeVolumeStrength(
      input({
        windowEndDate: utcDate(23),
        movements: [{ tonalId: "bench", bodyRegion: "upper", muscleGroups: ["Chest"] }],
        performanceRows: [
          ...performanceRows,
          { movementId: "unknown", date: utcDate(0), sets: 1, totalVolume: 1 },
          { movementId: "unknown", date: utcDate(12), sets: 1, totalVolume: 1 },
        ],
        strengthSnapshots,
      }),
    );

    expect(result.personalMrvEstimates).toEqual([
      {
        muscleGroup: "Chest",
        region: "upper",
        status: "insufficient_data",
        pairedObservationCount: 22,
        reason: "not_enough_non_overlapping_history",
      },
    ]);
  });
});
