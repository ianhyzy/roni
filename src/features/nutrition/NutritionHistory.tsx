import { CalendarDays } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { NutritionDailyLog } from "./nutritionForm";

type NutritionHistoryProps = {
  readonly rows: readonly NutritionDailyLog[];
  readonly selectedDate: string;
  readonly onSelectDate: (calendarDate: string) => void;
};

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function NutritionHistory({ rows, selectedDate, onSelectDate }: NutritionHistoryProps) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center px-5 py-8 text-center">
          <CalendarDays className="size-7 text-muted-foreground" aria-hidden="true" />
          <p className="mt-3 font-medium text-foreground">No nutrition logs yet</p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Use the daily log above to record your first day.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <ol className="space-y-2">
      {rows.map((row) => {
        const metrics = formatMetrics(row);
        const selected = row.calendarDate === selectedDate;
        return (
          <li key={row.calendarDate}>
            <button
              type="button"
              className="flex min-h-16 w-full items-start justify-between gap-4 rounded-xl bg-card p-4 text-left ring-1 ring-border shadow-sm transition-colors duration-150 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-current:bg-primary/[0.04] aria-current:ring-primary/40"
              aria-current={selected ? "date" : undefined}
              onClick={() => onSelectDate(row.calendarDate)}
            >
              <span className="min-w-0">
                <time dateTime={row.calendarDate} className="block font-medium text-foreground">
                  {formatCalendarDate(row.calendarDate)}
                </time>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {metrics.length > 0 ? metrics.join(" · ") : "Metrics not recorded"}
                </span>
                {row.notes ? (
                  <span className="mt-1 block line-clamp-1 text-xs text-muted-foreground">
                    {row.notes}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs font-medium text-primary">
                {selected ? "Editing" : "Edit"}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function formatCalendarDate(calendarDate: string): string {
  return new Date(`${calendarDate}T12:00:00`).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMetrics(row: NutritionDailyLog): string[] {
  const metrics: string[] = [];
  if (row.caloriesKcal !== null) {
    metrics.push(`${NUMBER_FORMAT.format(row.caloriesKcal)} kcal`);
  }
  if (row.proteinGrams !== null) {
    metrics.push(`${NUMBER_FORMAT.format(row.proteinGrams)} g protein`);
  }
  if (row.carbsGrams !== null) {
    metrics.push(`${NUMBER_FORMAT.format(row.carbsGrams)} g carbs`);
  }
  if (row.fatGrams !== null) {
    metrics.push(`${NUMBER_FORMAT.format(row.fatGrams)} g fat`);
  }
  return metrics;
}
