"use client";

import { type FormEvent, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  buildNutritionTargetsInput,
  createNutritionMetricDraft,
  type NutritionMetricDraft,
  type NutritionTargets,
} from "./nutritionForm";

type TargetsMutationState =
  | { readonly status: "idle" }
  | { readonly status: "pending"; readonly operation: "save" | "clear" }
  | {
      readonly status: "error";
      readonly operation: "save" | "clear";
      readonly message: string;
    };

type DraftState = {
  readonly sourceKey: string;
  readonly draft: NutritionMetricDraft;
};

type NutritionTargetsFormProps = {
  readonly sourceKey: string;
  readonly initialTargets: NutritionTargets | null;
};

const METRIC_FIELDS: readonly {
  readonly key: keyof NutritionMetricDraft;
  readonly label: string;
  readonly unit: string;
  readonly maximum: number;
}[] = [
  { key: "caloriesKcal", label: "Calories", unit: "kcal", maximum: 20_000 },
  { key: "proteinGrams", label: "Protein", unit: "g", maximum: 2_000 },
  { key: "carbsGrams", label: "Carbohydrates", unit: "g", maximum: 2_000 },
  { key: "fatGrams", label: "Fat", unit: "g", maximum: 1_000 },
];

export function NutritionTargetsForm({ sourceKey, initialTargets }: NutritionTargetsFormProps) {
  const setTargets = useMutation(api.nutrition.setTargetsMine);
  const clearTargets = useMutation(api.nutrition.clearTargetsMine);
  const saveLocked = useRef(false);
  const clearLocked = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [mutationState, setMutationState] = useState<TargetsMutationState>({ status: "idle" });
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const draft =
    draftState?.sourceKey === sourceKey
      ? draftState.draft
      : createNutritionMetricDraft(initialTargets);
  const isPending = mutationState.status === "pending";
  const isSaving = mutationState.status === "pending" && mutationState.operation === "save";
  const isClearing = mutationState.status === "pending" && mutationState.operation === "clear";

  const updateDraft = (change: Partial<NutritionMetricDraft>) => {
    setDraftState((current) => ({
      sourceKey,
      draft: {
        ...(current?.sourceKey === sourceKey
          ? current.draft
          : createNutritionMetricDraft(initialTargets)),
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

    const result = buildNutritionTargetsInput(draft);
    if (result.status === "invalid") {
      setMutationState({ status: "error", operation: "save", message: result.message });
      focusError();
      return;
    }

    saveLocked.current = true;
    setMutationState({ status: "pending", operation: "save" });
    try {
      const saved = await setTargets(result.input);
      setDraftState({ sourceKey, draft: createNutritionMetricDraft(saved) });
      setMutationState({ status: "idle" });
      toast.success(initialTargets ? "Nutrition targets updated" : "Nutrition targets saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save nutrition targets.";
      setMutationState({ status: "error", operation: "save", message });
      toast.error(message);
      focusError();
    } finally {
      saveLocked.current = false;
    }
  };

  const handleClear = async () => {
    if (clearLocked.current || isPending) return;

    clearLocked.current = true;
    setMutationState({ status: "pending", operation: "clear" });
    try {
      await clearTargets({});
      setDraftState({ sourceKey, draft: createNutritionMetricDraft() });
      setMutationState({ status: "idle" });
      setClearDialogOpen(false);
      toast.success("Nutrition targets cleared");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not clear nutrition targets.";
      setMutationState({ status: "error", operation: "clear", message });
      toast.error(message);
    } finally {
      clearLocked.current = false;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Self-set daily targets</CardTitle>
        <CardDescription>
          Optional reference values you choose for yourself. Blank fields stay unknown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" aria-busy={isPending} onSubmit={handleSubmit}>
          <fieldset className="grid gap-4 sm:grid-cols-2" disabled={isPending}>
            <legend className="sr-only">Self-set daily target values</legend>
            {METRIC_FIELDS.map((metric) => (
              <div key={metric.key} className="space-y-2">
                <Label htmlFor={`nutrition-target-${metric.key}`}>
                  {metric.label} ({metric.unit})
                </Label>
                <Input
                  id={`nutrition-target-${metric.key}`}
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
          </fieldset>

          {mutationState.status === "error" && mutationState.operation === "save" ? (
            <p ref={errorRef} tabIndex={-1} className="text-sm text-destructive" role="alert">
              {mutationState.message}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-between">
            <div>
              {initialTargets ? (
                <Dialog
                  open={clearDialogOpen}
                  onOpenChange={(open) => {
                    if (isClearing) return;
                    setClearDialogOpen(open);
                    if (
                      !open &&
                      mutationState.status === "error" &&
                      mutationState.operation === "clear"
                    ) {
                      setMutationState({ status: "idle" });
                    }
                  }}
                >
                  <DialogTrigger
                    render={
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 w-full sm:w-auto"
                        disabled={isPending}
                      />
                    }
                  >
                    <RotateCcw aria-hidden="true" />
                    Clear targets
                  </DialogTrigger>
                  <DialogContent showCloseButton={false}>
                    <DialogHeader>
                      <DialogTitle>Clear your nutrition targets?</DialogTitle>
                      <DialogDescription>
                        This removes every self-set nutrition target. Your daily logs are not
                        affected.
                      </DialogDescription>
                    </DialogHeader>
                    {mutationState.status === "error" && mutationState.operation === "clear" ? (
                      <Alert variant="destructive">
                        <AlertTriangle aria-hidden="true" />
                        <AlertTitle>Targets were not cleared</AlertTitle>
                        <AlertDescription>{mutationState.message}</AlertDescription>
                      </Alert>
                    ) : null}
                    <DialogFooter>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11"
                        disabled={isClearing}
                        onClick={() => setClearDialogOpen(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        className="h-11"
                        disabled={isClearing}
                        aria-busy={isClearing}
                        onClick={handleClear}
                      >
                        {isClearing ? (
                          <Loader2 className="motion-safe:animate-spin" aria-hidden="true" />
                        ) : null}
                        {isClearing ? "Clearing targets" : "Clear targets"}
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
                ? "Saving targets"
                : initialTargets
                  ? "Update targets"
                  : "Save targets"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
