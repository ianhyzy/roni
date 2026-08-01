"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

type Score = 1 | 2 | 3 | 4 | 5;
type SignalKey = "energy" | "soreness" | "stress";

type RecoveryCheckInView = {
  readonly calendarDate: string;
  readonly energy: number;
  readonly soreness: number;
  readonly stress: number;
  readonly notes: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

type FormValues = {
  readonly energy: Score | null;
  readonly soreness: Score | null;
  readonly stress: Score | null;
  readonly notes: string;
};

type RecoveryDraft = {
  readonly sourceKey: string;
  readonly values: Partial<{
    readonly energy: Score;
    readonly soreness: Score;
    readonly stress: Score;
    readonly notes: string;
  }>;
};

const SCORES: readonly Score[] = [1, 2, 3, 4, 5];
const SIGNALS: readonly {
  readonly key: SignalKey;
  readonly label: string;
  readonly low: string;
  readonly high: string;
}[] = [
  { key: "energy", label: "Energy", low: "Very low", high: "Very high" },
  { key: "soreness", label: "Soreness", low: "None", high: "Severe" },
  { key: "stress", label: "Stress", low: "Very low", high: "Very high" },
];

function getLocalCalendarDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeScore(value: number | undefined): Score | null {
  switch (value) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      return value;
    default:
      return null;
  }
}

function createFormValues(
  row: RecoveryCheckInView | undefined,
  draft: RecoveryDraft["values"],
): FormValues {
  return {
    energy: draft.energy ?? normalizeScore(row?.energy),
    soreness: draft.soreness ?? normalizeScore(row?.soreness),
    stress: draft.stress ?? normalizeScore(row?.stress),
    notes: draft.notes !== undefined ? draft.notes : (row?.notes ?? ""),
  };
}

function formatCalendarDate(calendarDate: string): string {
  return new Date(`${calendarDate}T12:00:00`).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function RecoveryCheckInCard() {
  const rows = useQuery(api.recoveryCheckIns.listRecentMine, {});
  const upsert = useMutation(api.recoveryCheckIns.upsertMine);
  const today = getLocalCalendarDate(new Date());
  const todayRow = rows?.find((row) => row.calendarDate === today);
  const sourceKey = rows === undefined ? "loading" : `${today}:${todayRow?.updatedAt ?? "new"}`;
  const [draft, setDraft] = useState<RecoveryDraft | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const draftValues = draft?.sourceKey === sourceKey ? draft.values : {};
  const form = createFormValues(todayRow, draftValues);

  const updateDraft = (values: RecoveryDraft["values"]) => {
    setDraft((current) => ({
      sourceKey,
      values: current?.sourceKey === sourceKey ? { ...current.values, ...values } : values,
    }));
  };

  if (rows === undefined) {
    return (
      <Card role="status" aria-label="Loading recovery check-in">
        <CardContent className="space-y-4 p-4">
          <div className="h-5 w-40 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="h-11 w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="h-11 w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="h-11 w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </CardContent>
      </Card>
    );
  }

  const recentRows = rows.filter((row) => row.calendarDate !== today);
  const isComplete = form.energy !== null && form.soreness !== null && form.stress !== null;

  const save = async () => {
    const { energy, soreness, stress } = form;
    if (energy === null || soreness === null || stress === null || isSaving) return;
    setIsSaving(true);
    try {
      await upsert({
        calendarDate: today,
        energy,
        soreness,
        stress,
        notes: form.notes || undefined,
      });
      toast.success(todayRow ? "Today's recovery updated" : "Recovery check-in saved");
    } catch {
      toast.error("Could not save recovery. Try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="space-y-5 p-4 sm:p-5">
          <div>
            <p className="text-xs font-semibold tracking-wide text-primary uppercase">Today</p>
            <h2 className="mt-1 text-lg font-semibold text-foreground">How ready do you feel?</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Three quick signals help your coach adjust today&apos;s advice.
            </p>
          </div>

          <div className="space-y-4">
            {SIGNALS.map((signal) => (
              <fieldset key={signal.key} className="space-y-2" disabled={isSaving}>
                <legend className="text-sm font-medium text-foreground">{signal.label}</legend>
                <div className="grid grid-cols-5 gap-2">
                  {SCORES.map((score) => {
                    const selected = form[signal.key] === score;
                    return (
                      <Button
                        key={score}
                        type="button"
                        variant={selected ? "default" : "outline"}
                        className="h-11 min-w-11 font-mono text-sm"
                        aria-label={`${signal.label} ${score} of 5`}
                        aria-pressed={selected}
                        onClick={() => updateDraft({ [signal.key]: score })}
                      >
                        {score}
                      </Button>
                    );
                  })}
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>{signal.low}</span>
                  <span>{signal.high}</span>
                </div>
              </fieldset>
            ))}
          </div>

          <div className="space-y-2">
            <label htmlFor="recovery-notes" className="text-sm font-medium text-foreground">
              Notes (optional)
            </label>
            <Textarea
              id="recovery-notes"
              maxLength={500}
              value={form.notes}
              disabled={isSaving}
              placeholder="Anything your coach should know?"
              onChange={(event) => updateDraft({ notes: event.target.value })}
            />
          </div>

          <Button
            className="h-11 w-full sm:w-auto"
            disabled={!isComplete || isSaving}
            aria-busy={isSaving}
            onClick={save}
          >
            <span aria-live="polite">
              {isSaving
                ? "Saving recovery"
                : todayRow
                  ? "Update today's recovery"
                  : "Save today's recovery"}
            </span>
          </Button>
        </CardContent>
      </Card>

      {recentRows.length > 0 ? (
        <section aria-labelledby="recent-recovery-heading">
          <h2 id="recent-recovery-heading" className="mb-2 text-sm font-semibold text-foreground">
            Recent recovery
          </h2>
          <ul className="divide-y divide-border rounded-xl bg-card px-4 ring-1 ring-border">
            {recentRows.map((row) => (
              <li key={row.calendarDate} className="flex items-start justify-between gap-4 py-3">
                <div>
                  <p className="font-mono text-xs font-medium text-foreground">
                    {formatCalendarDate(row.calendarDate)}
                  </p>
                  {row.notes ? (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{row.notes}</p>
                  ) : null}
                </div>
                <p
                  className="shrink-0 font-mono text-xs text-muted-foreground"
                  aria-label={`Energy ${row.energy}, soreness ${row.soreness}, stress ${row.stress}`}
                >
                  E{row.energy} · S{row.soreness} · T{row.stress}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
