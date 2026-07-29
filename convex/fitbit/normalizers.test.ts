import { describe, expect, it } from "vitest";
import { normalizeFitbitExercises, normalizeFitbitWellness } from "./normalizers";

const fitbitSource = { platform: "FITBIT" };

describe("normalizeFitbitExercises", () => {
  it("maps Fitbit exercise summaries with elapsed duration", () => {
    const rows = normalizeFitbitExercises([
      {
        name: "users/health-1/dataTypes/exercise/dataPoints/exercise-1",
        dataSource: fitbitSource,
        exercise: {
          interval: {
            startTime: "2026-07-20T12:00:00Z",
            endTime: "2026-07-20T12:40:00Z",
          },
          exerciseType: "RUNNING",
          displayName: "Trail Run",
          activeDuration: "2100s",
          metricsSummary: {
            caloriesKcal: 420,
            distanceMillimeters: 5_000_000,
            averageHeartRateBeatsPerMinute: "148",
            averagePaceSecondsPerMeter: 0.42,
          },
        },
      },
    ]);

    expect(rows).toEqual([
      {
        externalId: "google-health:users/health-1/dataTypes/exercise/dataPoints/exercise-1",
        workoutType: "Trail Run",
        beginTime: "2026-07-20T12:00:00.000Z",
        totalDuration: 2400,
        activeCalories: 420,
        totalCalories: 420,
        averageHeartRate: 148,
        source: "fitbit",
        distance: 5000,
        avgPaceSecondsPerKm: 420,
      },
    ]);
  });

  it("ignores malformed exercise points from non-Fitbit sources", () => {
    expect(
      normalizeFitbitExercises([
        {
          name: "google-web",
          dataSource: { platform: "GOOGLE_WEB_API" },
          exercise: {},
        },
      ]),
    ).toEqual([]);
  });

  it("fails closed on malformed Fitbit exercise points", () => {
    expect(() =>
      normalizeFitbitExercises([{ name: "malformed", dataSource: fitbitSource, exercise: {} }]),
    ).toThrow("Malformed Fitbit exercise data point");
  });

  it("fails closed on invalid Fitbit exercise metrics", () => {
    expect(() =>
      normalizeFitbitExercises([
        {
          name: "negative-metrics",
          dataSource: fitbitSource,
          exercise: {
            interval: {
              startTime: "2026-07-20T18:00:00Z",
              endTime: "2026-07-20T18:30:00Z",
            },
            exerciseType: "RUNNING",
            displayName: "Running",
            metricsSummary: { caloriesKcal: -1 },
          },
        },
      ]),
    ).toThrow("Malformed Fitbit exercise data point");
  });
});

describe("normalizeFitbitWellness", () => {
  it("keeps the longest non-nap sleep and merges daily recovery metrics", () => {
    const rows = normalizeFitbitWellness({
      sleeps: [
        {
          name: "nap",
          dataSource: fitbitSource,
          sleep: {
            interval: {
              startTime: "2026-07-20T18:00:00Z",
              endTime: "2026-07-20T18:30:00Z",
              civilEndTime: { date: { year: 2026, month: 7, day: 20 } },
            },
            metadata: { nap: true },
            summary: { minutesAsleep: "25" },
          },
        },
        {
          name: "shorter-sleep",
          dataSource: fitbitSource,
          sleep: {
            interval: {
              startTime: "2026-07-21T06:00:00Z",
              endTime: "2026-07-21T12:00:00Z",
              civilEndTime: { date: { year: 2026, month: 7, day: 21 } },
            },
            metadata: { nap: false },
            summary: {
              minutesAsleep: "330",
              stagesSummary: [{ type: "DEEP", minutes: "200" }],
            },
          },
        },
        {
          name: "main-sleep",
          dataSource: { platform: "FITBIT_WEB_API" },
          sleep: {
            interval: {
              startTime: "2026-07-21T05:00:00Z",
              endTime: "2026-07-21T12:30:00Z",
              civilEndTime: { date: { year: 2026, month: 7, day: 21 } },
            },
            metadata: { nap: false },
            summary: {
              minutesAsleep: "420",
              minutesAwake: "30",
              stagesSummary: [
                { type: "DEEP", minutes: "70" },
                { type: "LIGHT", minutes: "250" },
                { type: "REM", minutes: "100" },
                { type: "AWAKE", minutes: "30" },
              ],
            },
          },
        },
      ],
      restingHeartRates: [
        {
          name: "rhr",
          dataSource: fitbitSource,
          dailyRestingHeartRate: {
            date: { year: 2026, month: 7, day: 21 },
            beatsPerMinute: "54",
          },
        },
      ],
      heartRateVariability: [
        {
          name: "hrv",
          dataSource: fitbitSource,
          dailyHeartRateVariability: {
            date: { year: 2026, month: 7, day: 21 },
            averageHeartRateVariabilityMilliseconds: 46.5,
          },
        },
      ],
    });

    expect(rows).toEqual([
      {
        calendarDate: "2026-07-21",
        fields: {
          sleepDurationSeconds: 25_200,
          deepSleepSeconds: 4200,
          lightSleepSeconds: 15_000,
          remSleepSeconds: 6000,
          awakeSeconds: 1800,
          sleepStartTime: "2026-07-21T05:00:00.000Z",
          sleepEndTime: "2026-07-21T12:30:00.000Z",
          restingHeartRate: 54,
          averageHrvMilliseconds: 46.5,
        },
      },
    ]);
  });

  it("drops daily metrics from non-Fitbit platforms", () => {
    const rows = normalizeFitbitWellness({
      sleeps: [],
      restingHeartRates: [
        {
          name: "rhr",
          dataSource: { platform: "HEALTH_CONNECT" },
          dailyRestingHeartRate: {
            date: { year: 2026, month: 7, day: 21 },
            beatsPerMinute: "54",
          },
        },
      ],
      heartRateVariability: [],
    });

    expect(rows).toEqual([]);
  });

  it("fails closed on malformed Fitbit sleep while filtering malformed non-Fitbit sleep", () => {
    const malformedSleep = {
      name: "malformed-sleep",
      dataSource: fitbitSource,
      sleep: { interval: { startTime: "not-a-time" } },
    };

    expect(() =>
      normalizeFitbitWellness({
        sleeps: [malformedSleep],
        restingHeartRates: [],
        heartRateVariability: [],
      }),
    ).toThrow("Malformed Fitbit sleep data point");
    expect(
      normalizeFitbitWellness({
        sleeps: [{ ...malformedSleep, dataSource: { platform: "HEALTH_CONNECT" } }],
        restingHeartRates: [],
        heartRateVariability: [],
      }),
    ).toEqual([]);
  });

  it("fails closed on malformed Fitbit RHR while filtering malformed non-Fitbit RHR", () => {
    const malformedRhr = {
      name: "malformed-rhr",
      dataSource: fitbitSource,
      dailyRestingHeartRate: {
        date: { year: 2026, month: 7, day: 21 },
        beatsPerMinute: "not-a-number",
      },
    };

    expect(() =>
      normalizeFitbitWellness({
        sleeps: [],
        restingHeartRates: [malformedRhr],
        heartRateVariability: [],
      }),
    ).toThrow("Malformed Fitbit resting heart rate data point");
    expect(
      normalizeFitbitWellness({
        sleeps: [],
        restingHeartRates: [{ ...malformedRhr, dataSource: { platform: "HEALTH_CONNECT" } }],
        heartRateVariability: [],
      }),
    ).toEqual([]);
  });

  it("fails closed on malformed Fitbit HRV while filtering malformed non-Fitbit HRV", () => {
    const malformedHrv = {
      name: "malformed-hrv",
      dataSource: fitbitSource,
      dailyHeartRateVariability: { date: { year: 2026, month: 7, day: 21 } },
    };

    expect(() =>
      normalizeFitbitWellness({
        sleeps: [],
        restingHeartRates: [],
        heartRateVariability: [malformedHrv],
      }),
    ).toThrow("Malformed Fitbit heart rate variability data point");
    expect(
      normalizeFitbitWellness({
        sleeps: [],
        restingHeartRates: [],
        heartRateVariability: [{ ...malformedHrv, dataSource: { platform: "HEALTH_CONNECT" } }],
      }),
    ).toEqual([]);
  });

  it("keeps only the newest 30 distinct wellness dates", () => {
    const rows = normalizeFitbitWellness({
      sleeps: [],
      restingHeartRates: [],
      heartRateVariability: Array.from({ length: 31 }, (_, index) => ({
        name: `hrv-${index + 1}`,
        dataSource: fitbitSource,
        dailyHeartRateVariability: {
          date: { year: 2026, month: 7, day: index + 1 },
          averageHeartRateVariabilityMilliseconds: 40 + index,
        },
      })),
    });

    expect(rows).toHaveLength(30);
    expect(rows[0].calendarDate).toBe("2026-07-02");
    expect(rows[29].calendarDate).toBe("2026-07-31");
  });
});
