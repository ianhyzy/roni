import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";

export const DEFAULT_NUTRITION_LIST_LIMIT = 14;
export const MAX_NUTRITION_LIST_LIMIT = 31;
const MAX_NOTES_LENGTH = 500;

export const nutritionMetricArgs = {
  caloriesKcal: v.optional(v.number()),
  proteinGrams: v.optional(v.number()),
  carbsGrams: v.optional(v.number()),
  fatGrams: v.optional(v.number()),
};

export const nutritionDailyLogViewValidator = v.object({
  calendarDate: v.string(),
  source: v.literal("manual"),
  caloriesKcal: v.union(v.number(), v.null()),
  proteinGrams: v.union(v.number(), v.null()),
  carbsGrams: v.union(v.number(), v.null()),
  fatGrams: v.union(v.number(), v.null()),
  notes: v.union(v.string(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const nutritionTargetsViewValidator = v.object({
  source: v.literal("self_set"),
  caloriesKcal: v.union(v.number(), v.null()),
  proteinGrams: v.union(v.number(), v.null()),
  carbsGrams: v.union(v.number(), v.null()),
  fatGrams: v.union(v.number(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

type NutritionMetricsInput = {
  readonly caloriesKcal?: number;
  readonly proteinGrams?: number;
  readonly carbsGrams?: number;
  readonly fatGrams?: number;
};

export type NormalizedNutritionMetrics = NutritionMetricsInput;

type NutritionDailyLogInput = NutritionMetricsInput & {
  readonly calendarDate: string;
  readonly notes?: string;
};

export type NormalizedNutritionDailyLog = NormalizedNutritionMetrics & {
  readonly calendarDate: string;
  readonly notes?: string;
};

export type NutritionDailyLogView = {
  readonly calendarDate: string;
  readonly source: "manual";
  readonly caloriesKcal: number | null;
  readonly proteinGrams: number | null;
  readonly carbsGrams: number | null;
  readonly fatGrams: number | null;
  readonly notes: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type NutritionTargetsView = {
  readonly source: "self_set";
  readonly caloriesKcal: number | null;
  readonly proteinGrams: number | null;
  readonly carbsGrams: number | null;
  readonly fatGrams: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

function assertMetric(name: string, value: number | undefined, maximum: number): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > maximum)) {
    throw new Error(`${name} must be a finite number from 0 to ${maximum}`);
  }
}

function normalizeMetrics(input: NutritionMetricsInput): NormalizedNutritionMetrics {
  const hasMetric =
    input.caloriesKcal !== undefined ||
    input.proteinGrams !== undefined ||
    input.carbsGrams !== undefined ||
    input.fatGrams !== undefined;
  if (!hasMetric) throw new Error("at least one nutrition metric is required");

  assertMetric("caloriesKcal", input.caloriesKcal, 20_000);
  assertMetric("proteinGrams", input.proteinGrams, 2_000);
  assertMetric("carbsGrams", input.carbsGrams, 2_000);
  assertMetric("fatGrams", input.fatGrams, 1_000);

  return {
    ...(input.caloriesKcal !== undefined ? { caloriesKcal: input.caloriesKcal } : {}),
    ...(input.proteinGrams !== undefined ? { proteinGrams: input.proteinGrams } : {}),
    ...(input.carbsGrams !== undefined ? { carbsGrams: input.carbsGrams } : {}),
    ...(input.fatGrams !== undefined ? { fatGrams: input.fatGrams } : {}),
  };
}

export function assertValidNutritionCalendarDate(calendarDate: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDate);
  if (!match) throw new Error("calendarDate must be a valid YYYY-MM-DD date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("calendarDate must be a valid YYYY-MM-DD date");
  }
}

export function normalizeNutritionDailyLog(
  input: NutritionDailyLogInput,
): NormalizedNutritionDailyLog {
  assertValidNutritionCalendarDate(input.calendarDate);
  const metrics = normalizeMetrics(input);
  const notes = input.notes?.trim();
  if (notes && notes.length > MAX_NOTES_LENGTH) {
    throw new Error(`notes must be ${MAX_NOTES_LENGTH} characters or fewer`);
  }
  return {
    calendarDate: input.calendarDate,
    ...metrics,
    ...(notes ? { notes } : {}),
  };
}

export function normalizeNutritionTargets(
  input: NutritionMetricsInput,
): NormalizedNutritionMetrics {
  return normalizeMetrics(input);
}

export function toNutritionDailyLogView(row: Doc<"nutritionDailyLogs">): NutritionDailyLogView {
  return {
    calendarDate: row.calendarDate,
    source: row.source,
    caloriesKcal: row.caloriesKcal ?? null,
    proteinGrams: row.proteinGrams ?? null,
    carbsGrams: row.carbsGrams ?? null,
    fatGrams: row.fatGrams ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toNutritionTargetsView(row: Doc<"nutritionTargets">): NutritionTargetsView {
  return {
    source: row.source,
    caloriesKcal: row.caloriesKcal ?? null,
    proteinGrams: row.proteinGrams ?? null,
    carbsGrams: row.carbsGrams ?? null,
    fatGrams: row.fatGrams ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
