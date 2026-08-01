import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";

export type NutritionDailyLog = FunctionReturnType<typeof api.nutrition.listRecentMine>[number];
export type NutritionTargets = NonNullable<FunctionReturnType<typeof api.nutrition.getTargetsMine>>;
export type NutritionDailyInput = FunctionArgs<typeof api.nutrition.upsertDailyMine>;
export type NutritionTargetsInput = FunctionArgs<typeof api.nutrition.setTargetsMine>;

export type NutritionMetricDraft = {
  readonly caloriesKcal: string;
  readonly proteinGrams: string;
  readonly carbsGrams: string;
  readonly fatGrams: string;
};

export type NutritionDailyDraft = NutritionMetricDraft & {
  readonly notes: string;
};

export type NutritionFormResult<T> =
  | { readonly status: "valid"; readonly input: T }
  | { readonly status: "invalid"; readonly message: string };

type MetricKey = keyof NutritionMetricDraft;

const METRICS: readonly {
  readonly key: MetricKey;
  readonly label: string;
  readonly maximum: number;
}[] = [
  { key: "caloriesKcal", label: "Calories", maximum: 20_000 },
  { key: "proteinGrams", label: "Protein", maximum: 2_000 },
  { key: "carbsGrams", label: "Carbohydrates", maximum: 2_000 },
  { key: "fatGrams", label: "Fat", maximum: 1_000 },
];
const MAX_NOTES_LENGTH = 500;

export function getLocalCalendarDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createNutritionMetricDraft(
  source?: NutritionDailyLog | NutritionTargets | null,
): NutritionMetricDraft {
  return {
    caloriesKcal: source?.caloriesKcal?.toString() ?? "",
    proteinGrams: source?.proteinGrams?.toString() ?? "",
    carbsGrams: source?.carbsGrams?.toString() ?? "",
    fatGrams: source?.fatGrams?.toString() ?? "",
  };
}

export function createNutritionDailyDraft(source?: NutritionDailyLog | null): NutritionDailyDraft {
  return {
    ...createNutritionMetricDraft(source),
    notes: source?.notes ?? "",
  };
}

export function buildNutritionDailyInput(
  calendarDate: string,
  draft: NutritionDailyDraft,
): NutritionFormResult<NutritionDailyInput> {
  if (!isValidNutritionCalendarDate(calendarDate)) {
    return invalid("Choose a valid date.");
  }

  const metrics = parseMetrics(draft);
  if (metrics.status === "invalid") return metrics;

  const notes = draft.notes.trim();
  if (notes.length > MAX_NOTES_LENGTH) {
    return invalid(`Notes must be ${MAX_NOTES_LENGTH} characters or fewer.`);
  }

  return {
    status: "valid",
    input: {
      calendarDate,
      ...metrics.input,
      ...(notes ? { notes } : {}),
    },
  };
}

export function buildNutritionTargetsInput(
  draft: NutritionMetricDraft,
): NutritionFormResult<NutritionTargetsInput> {
  return parseMetrics(draft);
}

function parseMetrics(draft: NutritionMetricDraft): NutritionFormResult<NutritionTargetsInput> {
  const input: Partial<Record<MetricKey, number>> = {};
  for (const metric of METRICS) {
    const value = draft[metric.key].trim();
    if (!value) continue;

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > metric.maximum) {
      return invalid(`${metric.label} must be between 0 and ${metric.maximum}.`);
    }
    input[metric.key] = parsed;
  }

  if (Object.keys(input).length === 0) {
    return invalid("Enter at least one nutrition metric.");
  }
  return { status: "valid", input };
}

export function isValidNutritionCalendarDate(calendarDate: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDate);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function invalid<T>(message: string): NutritionFormResult<T> {
  return { status: "invalid", message };
}
