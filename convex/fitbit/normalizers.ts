import { z } from "zod";
import { EXTERNAL_ACTIVITY_SOURCES } from "../tonal/externalActivitySources";

const fitbitPlatforms = new Set(["FITBIT", "FITBIT_WEB_API"]);
const MAX_FITBIT_WELLNESS_DAYS = 30;
const timestampSchema = z.string().datetime({ offset: true });
const nonnegativeNumberStringSchema = z.string().refine((value) => {
  if (value.trim() === "") return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
});
const dateSchema = z.object({
  year: z.number().int(),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
});
const sourceSchema = z.object({ platform: z.string() }).passthrough();
const dataPointSourceSchema = z.object({ dataSource: sourceSchema }).passthrough();
const intervalSchema = z
  .object({
    startTime: timestampSchema,
    endTime: timestampSchema,
    civilEndTime: z.object({ date: dateSchema }).passthrough().optional(),
  })
  .passthrough();
const metricsSchema = z
  .object({
    caloriesKcal: z.number().finite().nonnegative().optional(),
    distanceMillimeters: z.number().finite().nonnegative().optional(),
    averageHeartRateBeatsPerMinute: z.string().optional(),
    averagePaceSecondsPerMeter: z.number().finite().nonnegative().optional(),
  })
  .passthrough();
const exercisePointSchema = z
  .object({
    name: z.string().min(1),
    dataSource: sourceSchema,
    exercise: z
      .object({
        interval: intervalSchema,
        exerciseType: z.string().min(1),
        displayName: z.string().min(1),
        metricsSummary: metricsSchema,
      })
      .passthrough(),
  })
  .passthrough();
const stageSummarySchema = z.object({
  type: z.string(),
  minutes: nonnegativeNumberStringSchema,
});
const sleepPointSchema = z
  .object({
    name: z.string().min(1),
    dataSource: sourceSchema,
    sleep: z
      .object({
        interval: intervalSchema,
        metadata: z.object({ nap: z.boolean().optional() }).passthrough().optional(),
        summary: z
          .object({
            minutesAsleep: nonnegativeNumberStringSchema.optional(),
            minutesAwake: nonnegativeNumberStringSchema.optional(),
            stagesSummary: z.array(stageSummarySchema).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
const restingHeartRatePointSchema = z
  .object({
    name: z.string().min(1),
    dataSource: sourceSchema,
    dailyRestingHeartRate: z.object({
      date: dateSchema,
      beatsPerMinute: nonnegativeNumberStringSchema,
    }),
  })
  .passthrough();
const heartRateVariabilityPointSchema = z
  .object({
    name: z.string().min(1),
    dataSource: sourceSchema,
    dailyHeartRateVariability: z.object({
      date: dateSchema,
      averageHeartRateVariabilityMilliseconds: z.number().finite().nonnegative(),
    }),
  })
  .passthrough();

export interface NormalizedFitbitActivity {
  externalId: string;
  workoutType: string;
  beginTime: string;
  totalDuration: number;
  source: typeof EXTERNAL_ACTIVITY_SOURCES.FITBIT;
  activeCalories?: number;
  totalCalories?: number;
  averageHeartRate?: number;
  distance?: number;
  avgPaceSecondsPerKm?: number;
}

export interface FitbitWellnessPatch {
  sleepDurationSeconds?: number;
  deepSleepSeconds?: number;
  lightSleepSeconds?: number;
  remSleepSeconds?: number;
  awakeSeconds?: number;
  sleepStartTime?: string;
  sleepEndTime?: string;
  restingHeartRate?: number;
  averageHrvMilliseconds?: number;
}

export interface NormalizedFitbitWellness {
  calendarDate: string;
  fields: FitbitWellnessPatch;
}

function isFitbitSource(platform: string): boolean {
  return fitbitPlatforms.has(platform);
}

function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function normalizeTimestamp(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function formatDate(value: z.infer<typeof dateSchema>): string | null {
  const formatted = `${value.year.toString().padStart(4, "0")}-${value.month
    .toString()
    .padStart(2, "0")}-${value.day.toString().padStart(2, "0")}`;
  const parsed = new Date(`${formatted}T00:00:00Z`);
  return parsed.getUTCFullYear() === value.year &&
    parsed.getUTCMonth() + 1 === value.month &&
    parsed.getUTCDate() === value.day
    ? formatted
    : null;
}

export function normalizeFitbitExercises(
  rawPoints: readonly unknown[],
): NormalizedFitbitActivity[] {
  return rawPoints.flatMap((rawPoint) => {
    const source = dataPointSourceSchema.safeParse(rawPoint);
    if (!source.success || !isFitbitSource(source.data.dataSource.platform)) return [];

    const parsed = exercisePointSchema.safeParse(rawPoint);
    if (!parsed.success) throw new Error("Malformed Fitbit exercise data point");

    const { name, exercise } = parsed.data;
    const beginTime = normalizeTimestamp(exercise.interval.startTime);
    const endTime = Date.parse(exercise.interval.endTime);
    const startTime = Date.parse(exercise.interval.startTime);
    if (!beginTime || !Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      throw new Error("Malformed Fitbit exercise data point");
    }

    const totalDuration = (endTime - startTime) / 1000;
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
      throw new Error("Malformed Fitbit exercise data point");
    }

    const metrics = exercise.metricsSummary;
    const calories = metrics.caloriesKcal;
    const averageHeartRate = parsePositiveNumber(metrics.averageHeartRateBeatsPerMinute);
    return [
      {
        externalId: `google-health:${name}`,
        workoutType: exercise.displayName || exercise.exerciseType,
        beginTime,
        totalDuration,
        source: EXTERNAL_ACTIVITY_SOURCES.FITBIT,
        ...(calories === undefined ? {} : { activeCalories: calories, totalCalories: calories }),
        ...(averageHeartRate === undefined ? {} : { averageHeartRate }),
        ...(metrics.distanceMillimeters === undefined
          ? {}
          : { distance: metrics.distanceMillimeters / 1000 }),
        ...(metrics.averagePaceSecondsPerMeter === undefined
          ? {}
          : { avgPaceSecondsPerKm: metrics.averagePaceSecondsPerMeter * 1000 }),
      },
    ];
  });
}

function stageSeconds(
  stages: readonly z.infer<typeof stageSummarySchema>[] | undefined,
  stageType: string,
): number | undefined {
  const minutes = stages
    ?.filter((stage) => stage.type === stageType)
    .reduce((total, stage) => total + (parsePositiveNumber(stage.minutes) ?? 0), 0);
  return minutes === undefined || minutes === 0 ? undefined : minutes * 60;
}

function sleepCalendarDate(sleep: z.infer<typeof sleepPointSchema>["sleep"]): string | null {
  if (sleep.interval.civilEndTime) return formatDate(sleep.interval.civilEndTime.date);
  return normalizeTimestamp(sleep.interval.endTime)?.slice(0, 10) ?? null;
}

function sleepPatch(sleep: z.infer<typeof sleepPointSchema>["sleep"]): FitbitWellnessPatch | null {
  const start = normalizeTimestamp(sleep.interval.startTime);
  const end = normalizeTimestamp(sleep.interval.endTime);
  if (!start || !end) return null;
  const intervalSeconds = (Date.parse(end) - Date.parse(start)) / 1000;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null;
  const summary = sleep.summary;
  const asleepMinutes = parsePositiveNumber(summary?.minutesAsleep);
  const awakeMinutes = parsePositiveNumber(summary?.minutesAwake);
  return {
    sleepDurationSeconds: asleepMinutes === undefined ? intervalSeconds : asleepMinutes * 60,
    deepSleepSeconds: stageSeconds(summary?.stagesSummary, "DEEP"),
    lightSleepSeconds: stageSeconds(summary?.stagesSummary, "LIGHT"),
    remSleepSeconds: stageSeconds(summary?.stagesSummary, "REM"),
    awakeSeconds:
      stageSeconds(summary?.stagesSummary, "AWAKE") ??
      (awakeMinutes === undefined ? undefined : awakeMinutes * 60),
    sleepStartTime: start,
    sleepEndTime: end,
  };
}

function compactPatch(fields: FitbitWellnessPatch): FitbitWellnessPatch {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export function normalizeFitbitWellness({
  sleeps,
  restingHeartRates,
  heartRateVariability,
}: {
  sleeps: readonly unknown[];
  restingHeartRates: readonly unknown[];
  heartRateVariability: readonly unknown[];
}): NormalizedFitbitWellness[] {
  const byDate = new Map<string, FitbitWellnessPatch>();
  const sleepByDate = new Map<string, FitbitWellnessPatch>();

  for (const rawPoint of sleeps) {
    const source = dataPointSourceSchema.safeParse(rawPoint);
    if (!source.success || !isFitbitSource(source.data.dataSource.platform)) continue;
    const parsed = sleepPointSchema.safeParse(rawPoint);
    if (!parsed.success) throw new Error("Malformed Fitbit sleep data point");
    if (parsed.data.sleep.metadata?.nap === true) continue;
    const calendarDate = sleepCalendarDate(parsed.data.sleep);
    const fields = sleepPatch(parsed.data.sleep);
    if (!calendarDate || !fields) throw new Error("Malformed Fitbit sleep data point");
    const existing = sleepByDate.get(calendarDate);
    if (
      existing?.sleepDurationSeconds !== undefined &&
      existing.sleepDurationSeconds >= (fields.sleepDurationSeconds ?? 0)
    ) {
      continue;
    }
    sleepByDate.set(calendarDate, compactPatch(fields));
  }
  for (const [calendarDate, fields] of sleepByDate) {
    byDate.set(calendarDate, { ...byDate.get(calendarDate), ...fields });
  }

  for (const rawPoint of restingHeartRates) {
    const source = dataPointSourceSchema.safeParse(rawPoint);
    if (!source.success || !isFitbitSource(source.data.dataSource.platform)) continue;
    const parsed = restingHeartRatePointSchema.safeParse(rawPoint);
    if (!parsed.success) throw new Error("Malformed Fitbit resting heart rate data point");
    const calendarDate = formatDate(parsed.data.dailyRestingHeartRate.date);
    const restingHeartRate = parsePositiveNumber(parsed.data.dailyRestingHeartRate.beatsPerMinute);
    if (!calendarDate || restingHeartRate === undefined) {
      throw new Error("Malformed Fitbit resting heart rate data point");
    }
    byDate.set(calendarDate, { ...byDate.get(calendarDate), restingHeartRate });
  }

  for (const rawPoint of heartRateVariability) {
    const source = dataPointSourceSchema.safeParse(rawPoint);
    if (!source.success || !isFitbitSource(source.data.dataSource.platform)) continue;
    const parsed = heartRateVariabilityPointSchema.safeParse(rawPoint);
    if (!parsed.success) throw new Error("Malformed Fitbit heart rate variability data point");
    const calendarDate = formatDate(parsed.data.dailyHeartRateVariability.date);
    const averageHrvMilliseconds =
      parsed.data.dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds;
    if (!calendarDate) throw new Error("Malformed Fitbit heart rate variability data point");
    byDate.set(calendarDate, { ...byDate.get(calendarDate), averageHrvMilliseconds });
  }

  return [...byDate.entries()]
    .map(([calendarDate, fields]) => ({ calendarDate, fields: compactPatch(fields) }))
    .sort((left, right) => left.calendarDate.localeCompare(right.calendarDate))
    .slice(-MAX_FITBIT_WELLNESS_DAYS);
}
