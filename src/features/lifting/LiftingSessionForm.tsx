"use client";

import { type FormEvent, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LiftingExerciseEditor } from "./LiftingExerciseEditor";
import {
  buildLiftingSaveInput,
  createEmptyExerciseDraft,
  type LiftingExerciseDraft,
  type LiftingSaveTarget,
  type LiftingSessionDraft,
  type LiftingSessionSummary,
} from "./liftingForm";

type SubmissionState =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "error"; readonly message: string };

type LiftingSessionFormProps = {
  readonly initialDraft: LiftingSessionDraft;
  readonly target: LiftingSaveTarget;
  readonly onCancel: () => void;
  readonly onSaved: (session: LiftingSessionSummary) => void;
};

export function LiftingSessionForm({
  initialDraft,
  target,
  onCancel,
  onSaved,
}: LiftingSessionFormProps) {
  const saveSession = useMutation(api.liftingSessions.saveMine);
  const saveLocked = useRef(false);
  const [draft, setDraft] = useState(initialDraft);
  const [submission, setSubmission] = useState<SubmissionState>({ status: "idle" });
  const isPending = submission.status === "pending";
  const isEditing = target.kind === "replace";

  const updateDraft = (nextDraft: LiftingSessionDraft) => {
    setDraft(nextDraft);
    if (submission.status === "error") setSubmission({ status: "idle" });
  };

  const updateExercise = (clientId: string, exercise: LiftingExerciseDraft) => {
    updateDraft({
      ...draft,
      exercises: draft.exercises.map((current) =>
        current.clientId === clientId ? exercise : current,
      ),
    });
  };

  const removeExercise = (clientId: string) => {
    updateDraft({
      ...draft,
      exercises: draft.exercises.filter((exercise) => exercise.clientId !== clientId),
    });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveLocked.current) return;

    const result = buildLiftingSaveInput(draft, target);
    if (result.status === "invalid") {
      setSubmission({ status: "error", message: result.message });
      return;
    }

    saveLocked.current = true;
    setSubmission({ status: "pending" });
    try {
      const saved = await saveSession({ input: result.input });
      toast.success(isEditing ? "Lifting session updated" : "Lifting session saved");
      onSaved(saved);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save lifting session.";
      setSubmission({ status: "error", message });
      toast.error(message);
    } finally {
      saveLocked.current = false;
    }
  };

  return (
    <form className="space-y-5" aria-busy={isPending} onSubmit={handleSubmit}>
      <Card>
        <CardContent className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="lifting-title">Session title</Label>
            <Input
              id="lifting-title"
              className="h-11"
              value={draft.title}
              maxLength={100}
              required
              disabled={isPending}
              placeholder="e.g. Lower body strength"
              onChange={(event) => updateDraft({ ...draft, title: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lifting-date">Performed date</Label>
            <Input
              id="lifting-date"
              className="h-11"
              type="date"
              value={draft.performedDate}
              required
              disabled={isPending}
              onChange={(event) => updateDraft({ ...draft, performedDate: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="lifting-time">Performed time</Label>
            <Input
              id="lifting-time"
              className="h-11"
              type="time"
              value={draft.performedTime}
              required
              disabled={isPending}
              onChange={(event) => updateDraft({ ...draft, performedTime: event.target.value })}
            />
          </div>
          <div className="space-y-2 sm:col-span-2 sm:max-w-xs">
            <Label htmlFor="lifting-duration">Duration in minutes (optional)</Label>
            <Input
              id="lifting-duration"
              className="h-11"
              type="number"
              inputMode="numeric"
              min={1}
              max={1440}
              step={1}
              value={draft.durationMinutes}
              disabled={isPending}
              onChange={(event) => updateDraft({ ...draft, durationMinutes: event.target.value })}
            />
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="lifting-notes">Notes (optional)</Label>
            <Textarea
              id="lifting-notes"
              className="min-h-24"
              value={draft.notes}
              maxLength={1000}
              disabled={isPending}
              placeholder="How did the session feel?"
              onChange={(event) => updateDraft({ ...draft, notes: event.target.value })}
            />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {draft.exercises.map((exercise, exerciseIndex) => (
          <LiftingExerciseEditor
            key={exercise.clientId}
            exercise={exercise}
            exerciseIndex={exerciseIndex}
            canRemoveExercise={draft.exercises.length > 1}
            disabled={isPending}
            onChange={(nextExercise) => updateExercise(exercise.clientId, nextExercise)}
            onRemove={() => removeExercise(exercise.clientId)}
          />
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        className="h-11 w-full sm:w-auto"
        disabled={isPending || draft.exercises.length >= 20}
        onClick={() =>
          updateDraft({ ...draft, exercises: [...draft.exercises, createEmptyExerciseDraft()] })
        }
      >
        <Plus aria-hidden="true" />
        Add exercise
      </Button>

      {submission.status === "error" ? (
        <p className="text-sm text-destructive" role="alert">
          {submission.message}
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={isPending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" className="h-11" disabled={isPending} aria-busy={isPending}>
          {isPending ? <Loader2 className="motion-safe:animate-spin" aria-hidden="true" /> : null}
          {isPending ? "Saving session" : isEditing ? "Save changes" : "Save session"}
        </Button>
      </div>
    </form>
  );
}
