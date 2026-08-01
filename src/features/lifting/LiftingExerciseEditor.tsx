"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createEmptySetDraft,
  type LiftingExerciseDraft,
  type LiftingSetDraft,
} from "./liftingForm";

type LiftingExerciseEditorProps = {
  readonly exercise: LiftingExerciseDraft;
  readonly exerciseIndex: number;
  readonly canRemoveExercise: boolean;
  readonly disabled: boolean;
  readonly onChange: (exercise: LiftingExerciseDraft) => void;
  readonly onRemove: () => void;
};

export function LiftingExerciseEditor({
  exercise,
  exerciseIndex,
  canRemoveExercise,
  disabled,
  onChange,
  onRemove,
}: LiftingExerciseEditorProps) {
  const updateSet = (clientId: string, nextSet: LiftingSetDraft) => {
    onChange({
      ...exercise,
      sets: exercise.sets.map((set) => (set.clientId === clientId ? nextSet : set)),
    });
  };

  const removeSet = (clientId: string) => {
    onChange({
      ...exercise,
      sets: exercise.sets.filter((set) => set.clientId !== clientId),
    });
  };

  const exerciseNumber = exerciseIndex + 1;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="text-base">Exercise {exerciseNumber}</CardTitle>
        <Button
          type="button"
          variant="ghost"
          className="h-11 px-3 text-destructive"
          disabled={disabled || !canRemoveExercise}
          aria-label={`Remove exercise ${exerciseNumber}`}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
          Remove
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor={`lifting-exercise-${exerciseIndex}-name`}>Exercise name</Label>
          <Input
            id={`lifting-exercise-${exerciseIndex}-name`}
            className="h-11"
            value={exercise.name}
            maxLength={100}
            required
            disabled={disabled}
            placeholder="e.g. Barbell squat"
            onChange={(event) => onChange({ ...exercise, name: event.target.value })}
          />
        </div>

        <div className="space-y-3">
          {exercise.sets.map((set, setIndex) => {
            const setNumber = setIndex + 1;
            const fieldPrefix = `lifting-exercise-${exerciseIndex}-set-${setIndex}`;
            return (
              <fieldset
                key={set.clientId}
                className="rounded-xl border border-border bg-muted/20 p-3"
                disabled={disabled}
              >
                <legend className="px-1 text-sm font-medium text-foreground">
                  Set {setNumber}
                  <span className="sr-only"> for exercise {exerciseNumber}</span>
                </legend>
                <div className="mb-3 flex min-h-11 items-center justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11 px-3 text-muted-foreground"
                    disabled={disabled || exercise.sets.length === 1}
                    aria-label={`Remove set ${setNumber} from exercise ${exerciseNumber}`}
                    onClick={() => removeSet(set.clientId)}
                  >
                    <Trash2 aria-hidden="true" />
                    Remove
                  </Button>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="col-span-2 space-y-2 sm:col-span-1">
                    <Label htmlFor={`${fieldPrefix}-kind`}>Kind</Label>
                    <select
                      id={`${fieldPrefix}-kind`}
                      className="h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50"
                      value={set.kind}
                      onChange={(event) =>
                        updateSet(set.clientId, {
                          ...set,
                          kind: event.target.value === "warmup" ? "warmup" : "working",
                        })
                      }
                    >
                      <option value="warmup">Warm-up</option>
                      <option value="working">Working</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${fieldPrefix}-reps`}>Reps</Label>
                    <Input
                      id={`${fieldPrefix}-reps`}
                      className="h-11"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={1000}
                      step={1}
                      required
                      value={set.reps}
                      onChange={(event) =>
                        updateSet(set.clientId, { ...set, reps: event.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${fieldPrefix}-weight`}>Weight (lb)</Label>
                    <Input
                      id={`${fieldPrefix}-weight`}
                      className="h-11"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={5000}
                      step="any"
                      value={set.weightLbs}
                      onChange={(event) =>
                        updateSet(set.clientId, { ...set, weightLbs: event.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${fieldPrefix}-rpe`}>RPE</Label>
                    <Input
                      id={`${fieldPrefix}-rpe`}
                      className="h-11"
                      type="number"
                      inputMode="decimal"
                      min={1}
                      max={10}
                      step="any"
                      value={set.rpe}
                      onChange={(event) =>
                        updateSet(set.clientId, { ...set, rpe: event.target.value })
                      }
                    />
                  </div>
                </div>
              </fieldset>
            );
          })}
        </div>

        <Button
          type="button"
          variant="outline"
          className="h-11 w-full sm:w-auto"
          disabled={disabled || exercise.sets.length >= 20}
          onClick={() => onChange({ ...exercise, sets: [...exercise.sets, createEmptySetDraft()] })}
        >
          <Plus aria-hidden="true" />
          Add set
        </Button>
      </CardContent>
    </Card>
  );
}
