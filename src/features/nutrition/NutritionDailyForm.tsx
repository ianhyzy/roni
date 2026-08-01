"use client";

import { type FormEvent, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  buildNutritionDailyInput,
  createNutritionDailyDraft,
  type NutritionDailyDraft,
  type NutritionDailyLog,
} from "./nutritionForm";

type DailyMutationState =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly operation: "save" | "delete" }
  | {
      readonly status: "error";
      readonly operation: "save" | "delete";
      readonly message: string;
    };

type DraftState = {
  readonly sourceKey: string;
  readonly draft: NutritionDailyDraft;
};

type NutritionDailyFormProps = {
  readonly sourceKey: string;
  readonly calendarDate: string;
  readonly initialRow: NutritionDailyLog | null;
  readonly onCalendarDateChange: (calendarDate: string) => void;
};

const METRIC_FIELDS: readonly {
  readonly key: keyof Omit<NutritionDailyDraft, "notes">;
  readonly label: string;
  readonly unit: string;
  readonly maximum: number;
}[] = [
  { key: "caloriesKcal", label: "Calories", unit: "kcal", maximum: 20_000 },
  { key: "proteinGrams", label: "Protein", unit: "g", maximum: 2_000 },
  { key: "carbsGrams", label: "Carbohydrates", unit: "g", maximum: 2_000 },
  { key: "fatGrams", label: "Fat", unit: "g", maximum: 1_000 },
];

export function NutritionDailyForm({
  sourceKey,
  calendarDate,
  initialRow,
  onCalendarDateChange,
}: NutritionDailyFormProps) {
  const upsertDaily = useMutation(api.nutrition.upsertDailyMine);
  const deleteDaily = useMutation(api.nutrition.deleteDailyMine);
  const saveLocked = useRef(false);
  const deleteLocked = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [mutationState, setMutationState] = useState<DailyMutationState>({ status: "idle" });
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const draft =
    draftState?.sourceKey === sourceKey ? draftState.draft : createNutritionDailyDraft(initialRow);
  const isPending = mutationState.status === "pending";
  const isSaving = mutationState.status === "pending" && mutationState.operation === "save";
  const isDeleting = mutationState.status === "pending" && mutationState.operation === "delete";

  const updateDraft = (change: Partial<NutritionDailyDraft>) => {
    setDraftState((current) => ({
      sourceKey,
      draft: {
        ...(current?.sourceKey === sourceKey
          ? current.draft
          : createNutritionDailyDraft(initialRow)),
        ...change,
      },
    }));
    if (mutationState.status === "error" && mutationState.operation === "save") {
      setMutationState({ status: "idle" });
    }
  };

  const focusError = () => requestAnimationFrame(() => errorRef.current?.focus());

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveLocked.current || isPending) return;

    const result = buildNutritionDailyInput(calendarDate, draft);
    if (result.status === "invalid") {
      setMutationState({ status: "error", operation: "save", message: result.message });
      focusError();
      return;
    }

    saveLocked.current = true;
    setMutationState({ status: "pending", operation: "save" });
    try {
      const saved = await upsertDaily(result.input);
      setDraftState({ sourceKey, draft: createNutritionDailyDraft(saved) });
      setMutationState({ status: "idle" });
      toast.success(initialRow ? "Nutrition log updated" : "Nutrition log saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save nutrition log.";
      setMutationState({ status: "error", operation: "save", message });
      toast.error(message);
      focusError();
    } finally {
      saveLocked.current = false;
    }
  };

  const handleDelete = async () => {
    if (deleteLocked.current || isPending) return;

    deleteLocked.current = true;
    setMutationState({ status: "pending", operation: "delete" });
    try {
      await deleteDaily({ calendarDate });
      setDraftState({ sourceKey, draft: createNutritionDailyDraft() });
      setMutationState({ status: "idle" });
      setDeleteDialogOpen(false);
      toast.success("Nutrition log deleted");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete nutrition log.";
      setMutationState({ status: "error", operation: "delete", message });
      toast.error(message);
    } finally {
      deleteLocked.current = false;
    }
  };

  return (
    <Card>
      <CardContent className="p-4 sm:p-5">
        <form className="space-y-5" aria-busy={isPending} onSubmit={handleSubmit}>
          <div className="space-y-2 sm:max-w-xs">
            <Label htmlFor="nutrition-calendar-date">Date</Label>
            <Input
              id="nutrition-calendar-date"
              className="h-11"
              type="date"
              value={calendarDate}
              required
              disabled={isPending}
              onChange={(event) => onCalendarDateChange(event.target.value)}
            />
          </div>

          <fieldset className="space-y-3" disabled={isPending}>
            <legend className="text-sm font-medium text-foreground">Daily totals</legend>
            <p className="text-xs text-muted-foreground">
              Leave anything you did not track blank. A recorded zero stays zero.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              {METRIC_FIELDS.map((metric) => (
                <div key={metric.key} className="space-y-2">
                  <Label htmlFor={`nutrition-daily-${metric.key}`}>
                    {metric.label} ({metric.unit})
                  </Label>
                  <Input
                    id={`nutrition-daily-${metric.key}`}
                    className="h-11"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={metric.maximum}
                    step="any"
                    value={draft[metric.key]}
                    onChange={(event) => updateDraft({ [metric.key]: event.target.value })}
                  />
                </div>
              ))}
            </div>
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="nutrition-daily-notes">Notes (optional)</Label>
            <Textarea
              id="nutrition-daily-notes"
              className="min-h-24"
              maxLength={500}
              value={draft.notes}
              disabled={isPending}
              placeholder="Anything useful to remember about the day"
              onChange={(event) => updateDraft({ notes: event.target.value })}
            />
          </div>

          {mutationState.status === "error" && mutationState.operation === "save" ? (
            <p ref={errorRef} tabIndex={-1} className="text-sm text-destructive" role="alert">
              {mutationState.message}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-between">
            <div>
              {initialRow ? (
                <Dialog
                  open={deleteDialogOpen}
                  onOpenChange={(open) => {
                    if (isDeleting) return;
                    setDeleteDialogOpen(open);
                    if (
                      !open &&
                      mutationState.status === "error" &&
                      mutationState.operation === "delete"
                    ) {
                      setMutationState({ status: "idle" });
                    }
                  }}
                >
                  <DialogTrigger
                    render={
                      <Button
                        type="button"
                        variant="destructive"
                        className="h-11 w-full sm:w-auto"
                        disabled={isPending}
                      />
                    }
                  >
                    <Trash2 aria-hidden="true" />
                    Delete log
                  </DialogTrigger>
                  <DialogContent showCloseButton={false}>
                    <DialogHeader>
                      <DialogTitle>Delete the nutrition log for {calendarDate}?</DialogTitle>
                      <DialogDescription>
                        This permanently deletes the nutrition totals and notes recorded for this
                        date. This action cannot be undone.
                      </DialogDescription>
                    </DialogHeader>
                    {mutationState.status === "error" && mutationState.operation === "delete" ? (
                      <Alert variant="destructive">
                        <AlertTriangle aria-hidden="true" />
                        <AlertTitle>Log was not deleted</AlertTitle>
                        <AlertDescription>{mutationState.message}</AlertDescription>
                      </Alert>
                    ) : null}
                    <DialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11"
                        disabled={isDeleting}
                        onClick={() => setDeleteDialogOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        className="h-11"
                        disabled={isDeleting}
                        aria-busy={isDeleting}
                        onClick={handleDelete}
                      >
                        {isDeleting ? (
                          <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
                        ) : null}
                        {isDeleting ? "Deleting log" : "Delete log"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              ) : null}
            </div>
            <Button type="submit" className="h-11" disabled={isPending} aria-busy={isSaving}>
              {mutationState.status === "pending" && mutationState.operation === "save" ? (
                <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
              ) : null}
              {mutationState.status === "pending" && mutationState.operation === "save"
                ? "Saving log"
                : initialRow
                  ? "Update log"
                  : "Save log"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
