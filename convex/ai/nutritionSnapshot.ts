import type {
  NutritionDaySnapshot,
  NutritionSnapshot,
  NutritionTargetsSnapshot,
} from "../nutritionCoachProjection";
import type { SnapshotSection } from "./snapshotHelpers";
import { getCalendarDateRecencyLabel } from "./timeDecay";

const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

interface FormatNutritionSnapshotOptions {
  readonly nutrition: NutritionSnapshot;
  readonly now: Date;
  readonly userTimezone?: string;
}

function formatMetrics(
  metrics: NutritionDaySnapshot | NutritionTargetsSnapshot,
): ReadonlyArray<string> {
  const parts: string[] = [];
  if (metrics.caloriesKcal !== undefined) {
    parts.push(`${numberFormatter.format(metrics.caloriesKcal)} kcal`);
  }
  if (metrics.proteinGrams !== undefined) {
    parts.push(`${numberFormatter.format(metrics.proteinGrams)}g protein`);
  }
  if (metrics.carbsGrams !== undefined) {
    parts.push(`${numberFormatter.format(metrics.carbsGrams)}g carbs`);
  }
  if (metrics.fatGrams !== undefined) {
    parts.push(`${numberFormatter.format(metrics.fatGrams)}g fat`);
  }
  return parts;
}

export function formatNutritionSnapshot({
  nutrition,
  now,
  userTimezone,
}: FormatNutritionSnapshotOptions): SnapshotSection | null {
  const targetMetrics = nutrition.targets ? formatMetrics(nutrition.targets) : [];
  const dayLines = nutrition.days.flatMap((day) => {
    const metrics = formatMetrics(day);
    if (metrics.length === 0) return [];
    const recency = getCalendarDateRecencyLabel(day.calendarDate, now, userTimezone);
    return [`  [${recency.toUpperCase()}] ${day.calendarDate} | ${metrics.join(" | ")}`];
  });
  if (targetMetrics.length === 0 && dayLines.length === 0) return null;

  const lines = ["Nutrition (user-reported):"];
  if (targetMetrics.length > 0) {
    lines.push(`  Targets (self-set): ${targetMetrics.join(" | ")}`);
  }
  lines.push(...dayLines);
  lines.push(
    "  user-reported estimates; missing days/metrics are unknown, not zero; use only for general fueling/recovery context; do not diagnose deficiencies or give medical/dietetic advice.",
  );
  return { priority: 6, lines };
}
