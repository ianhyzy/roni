"use client";

import { useRef, useState } from "react";
import { useQuery } from "convex/react";
import { Utensils } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Skeleton } from "@/components/ui/skeleton";
import { NutritionDailyForm } from "./NutritionDailyForm";
import { NutritionHistory } from "./NutritionHistory";
import { NutritionTargetsForm } from "./NutritionTargetsForm";
import { getLocalCalendarDate, isValidNutritionCalendarDate } from "./nutritionForm";

const HISTORY_LIMIT = 31;

export function NutritionTracker() {
  const [selectedDate, setSelectedDate] = useState(() => getLocalCalendarDate());
  const dailyHeadingRef = useRef<HTMLHeadingElement>(null);
  const rows = useQuery(api.nutrition.listRecentMine, { limit: HISTORY_LIMIT });
  const targets = useQuery(api.nutrition.getTargetsMine, {});
  const selectedDateIsValid = isValidNutritionCalendarDate(selectedDate);
  const selectedRow = useQuery(
    api.nutrition.getDailyMine,
    selectedDateIsValid ? { calendarDate: selectedDate } : "skip",
  );
  const selectedRowView = selectedDateIsValid ? (selectedRow ?? null) : null;
  const dailySourceKey = `${selectedDate}:${selectedRowView?.updatedAt ?? "empty"}`;
  const targetsSourceKey = `targets:${targets?.updatedAt ?? "empty"}`;

  const selectHistoryDate = (calendarDate: string) => {
    setSelectedDate(calendarDate);
    requestAnimationFrame(() => dailyHeadingRef.current?.focus());
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6 lg:py-10">
      <header className="mb-8 border-b border-border/70 pb-6">
        <div className="flex items-center gap-2 text-primary">
          <Utensils className="size-5" aria-hidden="true" />
          <span className="text-xs font-semibold tracking-wide uppercase">Manual tracking</span>
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground">Nutrition</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Record only what you tracked. Blank fields stay unknown, while a recorded zero stays zero.
        </p>
      </header>

      <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
        <section aria-labelledby="nutrition-daily-heading">
          <h2
            ref={dailyHeadingRef}
            id="nutrition-daily-heading"
            tabIndex={-1}
            className="mb-3 scroll-mt-24 text-lg font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4"
          >
            Daily log
          </h2>
          {selectedDateIsValid && selectedRow === undefined ? (
            <div
              className="space-y-4 rounded-xl bg-card p-4 ring-1 ring-border"
              role="status"
              aria-label="Loading daily nutrition log"
            >
              <Skeleton className="h-11 w-full motion-reduce:animate-none" />
              <div className="grid gap-4 sm:grid-cols-2">
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className="h-16 w-full motion-reduce:animate-none" />
                ))}
              </div>
              <Skeleton className="h-24 w-full motion-reduce:animate-none" />
              <Skeleton className="h-11 w-32 motion-reduce:animate-none" />
            </div>
          ) : (
            <NutritionDailyForm
              key={selectedDate}
              sourceKey={dailySourceKey}
              calendarDate={selectedDate}
              initialRow={selectedRowView}
              onCalendarDateChange={setSelectedDate}
            />
          )}
        </section>

        <section aria-labelledby="nutrition-targets-heading">
          <h2 id="nutrition-targets-heading" className="mb-3 text-lg font-semibold">
            Daily reference
          </h2>
          {targets === undefined ? (
            <div
              className="space-y-4 rounded-xl bg-card p-4 ring-1 ring-border"
              role="status"
              aria-label="Loading nutrition targets"
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {[0, 1, 2, 3].map((index) => (
                  <Skeleton key={index} className="h-16 w-full motion-reduce:animate-none" />
                ))}
              </div>
              <Skeleton className="h-11 w-32 motion-reduce:animate-none" />
            </div>
          ) : (
            <NutritionTargetsForm sourceKey={targetsSourceKey} initialTargets={targets} />
          )}
        </section>

        <section className="lg:col-span-2" aria-labelledby="nutrition-history-heading">
          <div className="mb-3">
            <h2 id="nutrition-history-heading" className="text-lg font-semibold">
              Recent logs
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Select a date to review or edit that day.
            </p>
          </div>
          {rows === undefined ? (
            <div className="space-y-2" role="status" aria-label="Loading recent nutrition logs">
              {[0, 1, 2].map((index) => (
                <Skeleton
                  key={index}
                  className="h-20 w-full rounded-xl motion-reduce:animate-none"
                />
              ))}
            </div>
          ) : (
            <NutritionHistory
              rows={rows}
              selectedDate={selectedDate}
              onSelectDate={selectHistoryDate}
            />
          )}
        </section>
      </div>
    </div>
  );
}
