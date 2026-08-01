"use client";

import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import { AlertTriangle, Clock3, Dumbbell, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { LiftingSessionDetail as LiftingSessionDetailData } from "./liftingForm";

type DeletionState =
  | { readonly status: "idle" }
  | { readonly status: "pending" }
  | { readonly status: "error"; readonly message: string };

type LiftingSessionDetailProps = {
  readonly session: LiftingSessionDetailData;
  readonly onEdit: () => void;
  readonly onDeleted: () => void;
};

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function LiftingSessionDetail({ session, onEdit, onDeleted }: LiftingSessionDetailProps) {
  const deleteSession = useMutation(api.liftingSessions.deleteMine);
  const deleteLocked = useRef(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deletion, setDeletion] = useState<DeletionState>({ status: "idle" });
  const isDeleting = deletion.status === "pending";
  const performedAt = new Date(session.performedAt);
  const performedDate = new Date(`${session.calendarDate}T12:00:00`);

  const handleDelete = async () => {
    if (deleteLocked.current) return;
    deleteLocked.current = true;
    setDeletion({ status: "pending" });
    try {
      await deleteSession({ sessionId: session.sessionId });
      toast.success("Lifting session deleted");
      setDialogOpen(false);
      onDeleted();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not delete lifting session.";
      setDeletion({ status: "error", message });
      toast.error(message);
    } finally {
      deleteLocked.current = false;
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Manual</Badge>
              <span className="text-sm text-muted-foreground">
                {performedDate.toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
                {" at "}
                {performedAt.toLocaleTimeString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <CardTitle className="text-xl">{session.title}</CardTitle>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Button type="button" variant="outline" className="h-11 w-full" onClick={onEdit}>
              <Pencil aria-hidden="true" />
              Edit
            </Button>
            <Dialog
              open={dialogOpen}
              onOpenChange={(open) => {
                if (isDeleting) return;
                setDialogOpen(open);
                if (!open) setDeletion({ status: "idle" });
              }}
            >
              <DialogTrigger
                render={<Button variant="destructive" className="h-11 w-full" type="button" />}
              >
                <Trash2 aria-hidden="true" />
                Delete
              </DialogTrigger>
              <DialogContent showCloseButton={false}>
                <DialogHeader>
                  <DialogTitle>Delete this lifting session?</DialogTitle>
                  <DialogDescription>
                    This permanently deletes {session.title} and all of its sets. This action cannot
                    be undone.
                  </DialogDescription>
                </DialogHeader>
                {deletion.status === "error" ? (
                  <Alert variant="destructive">
                    <AlertTriangle aria-hidden="true" />
                    <AlertTitle>Session was not deleted</AlertTitle>
                    <AlertDescription>{deletion.message}</AlertDescription>
                  </Alert>
                ) : null}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={isDeleting}
                    onClick={() => setDialogOpen(false)}
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
                    {isDeleting ? "Deleting session" : "Delete session"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div className="rounded-lg bg-muted/40 p-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <Dumbbell className="size-4" aria-hidden="true" /> Exercises
              </dt>
              <dd className="mt-1 font-semibold">{session.exerciseCount}</dd>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <dt className="text-muted-foreground">Sets</dt>
              <dd className="mt-1 font-semibold">{session.setCount}</dd>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <dt className="text-muted-foreground">Volume</dt>
              <dd className="mt-1 font-semibold">
                {NUMBER_FORMAT.format(session.totalVolumeLbs)} lb
              </dd>
            </div>
            <div className="rounded-lg bg-muted/40 p-3">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <Clock3 className="size-4" aria-hidden="true" /> Duration
              </dt>
              <dd className="mt-1 font-semibold">
                {session.durationMinutes !== null
                  ? `${session.durationMinutes} min`
                  : "Not recorded"}
              </dd>
            </div>
          </dl>
          {session.notes ? (
            <div>
              <h2 className="text-sm font-medium">Notes</h2>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                {session.notes}
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <section className="space-y-3" aria-labelledby="lifting-exercises-heading">
        <h2 id="lifting-exercises-heading" className="text-lg font-semibold">
          Exercises
        </h2>
        {session.exercises.map((exercise) => (
          <Card key={exercise.exerciseId}>
            <CardHeader>
              <CardTitle className="text-base">{exercise.name}</CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="space-y-2">
                {exercise.sets.map((set) => (
                  <li
                    key={set.setId}
                    className="rounded-lg border border-border bg-muted/20 p-3 text-sm"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">Set {set.order + 1}</span>
                      <Badge variant="outline" className="capitalize">
                        {set.kind}
                      </Badge>
                    </div>
                    <dl className="mt-3 grid grid-cols-3 gap-3">
                      <div>
                        <dt className="text-xs text-muted-foreground">Reps</dt>
                        <dd className="mt-0.5 font-medium tabular-nums">{set.reps}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">Load</dt>
                        <dd className="mt-0.5 font-medium tabular-nums">
                          {set.weightLbs === null ? "Bodyweight" : `${set.weightLbs} lb`}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">RPE</dt>
                        <dd className="mt-0.5 font-medium tabular-nums">
                          {set.rpe === null ? "Not recorded" : set.rpe}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
