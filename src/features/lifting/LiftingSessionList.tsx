"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { ArrowLeft, ChevronRight, Dumbbell, Plus } from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LiftingSessionDetail } from "./LiftingSessionDetail";
import { LiftingSessionForm } from "./LiftingSessionForm";
import {
  createEmptyLiftingDraft,
  createLiftingDraftFromDetail,
  createLiftingReplaceTarget,
  type LiftingSessionDraft,
  type LiftingSessionId,
} from "./liftingForm";

type LiftingViewMode =
  | { readonly kind: "list" }
  | { readonly kind: "create"; readonly draft: LiftingSessionDraft }
  | { readonly kind: "view"; readonly sessionId: LiftingSessionId }
  | { readonly kind: "edit"; readonly sessionId: LiftingSessionId };

const NUMBER_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function LiftingSessionList() {
  const [mode, setMode] = useState<LiftingViewMode>({ kind: "list" });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousModeKind = useRef(mode.kind);
  const sessions = useQuery(api.liftingSessions.listMine, { limit: 50 });
  const activeSessionId = mode.kind === "view" || mode.kind === "edit" ? mode.sessionId : null;
  const activeSession = useQuery(
    api.liftingSessions.getMine,
    activeSessionId === null ? "skip" : { sessionId: activeSessionId },
  );

  const showList = () => setMode({ kind: "list" });
  const startCreate = () => setMode({ kind: "create", draft: createEmptyLiftingDraft() });
  const title =
    mode.kind === "list"
      ? "Manual lifting"
      : mode.kind === "create"
        ? "Log lifting session"
        : mode.kind === "edit"
          ? "Edit lifting session"
          : "Lifting session";

  useEffect(() => {
    if (previousModeKind.current === mode.kind) return;
    previousModeKind.current = mode.kind;
    headingRef.current?.focus();
  }, [mode.kind]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6 lg:py-10">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          {mode.kind !== "list" ? (
            <Button
              type="button"
              variant="ghost"
              className="mb-2 h-11 -ml-3 px-3"
              onClick={
                mode.kind === "edit" && activeSessionId !== null
                  ? () => setMode({ kind: "view", sessionId: activeSessionId })
                  : showList
              }
            >
              <ArrowLeft aria-hidden="true" />
              {mode.kind === "edit" ? "Back to session" : "Back to sessions"}
            </Button>
          ) : null}
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-bold tracking-tight text-foreground"
          >
            {title}
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            {mode.kind === "list"
              ? "Track gym sessions completed outside Tonal."
              : "Record exercises, sets, reps, load, and effort."}
          </p>
        </div>
        {mode.kind === "list" ? (
          <Button type="button" className="h-11" onClick={startCreate}>
            <Plus aria-hidden="true" />
            Log session
          </Button>
        ) : null}
      </header>

      {mode.kind === "create" ? (
        <LiftingSessionForm
          initialDraft={mode.draft}
          target={{ kind: "create" }}
          onCancel={showList}
          onSaved={(session) => setMode({ kind: "view", sessionId: session.sessionId })}
        />
      ) : null}

      {mode.kind === "list" && sessions === undefined ? (
        <div className="space-y-3" role="status" aria-label="Loading lifting sessions">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-28 w-full rounded-xl motion-reduce:animate-none" />
          ))}
        </div>
      ) : null}

      {mode.kind === "list" && sessions?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center px-5 py-10 text-center">
            <Dumbbell className="size-8 text-muted-foreground" aria-hidden="true" />
            <h2 className="mt-3 text-base font-semibold">No manual sessions yet</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Log lifting completed outside Tonal so your training history stays complete.
            </p>
            <Button type="button" className="mt-5 h-11" onClick={startCreate}>
              <Plus aria-hidden="true" />
              Log your first session
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {mode.kind === "list" && sessions && sessions.length > 0 ? (
        <ol className="space-y-3">
          {sessions.map((session) => {
            const performedDate = new Date(`${session.calendarDate}T12:00:00`);
            return (
              <li key={session.sessionId}>
                <button
                  type="button"
                  className="flex min-h-24 w-full items-center justify-between gap-4 rounded-xl bg-card p-4 text-left ring-1 ring-border shadow-sm transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() => setMode({ kind: "view", sessionId: session.sessionId })}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">
                      {session.title}
                    </span>
                    <span className="mt-1 block text-sm text-muted-foreground">
                      {performedDate.toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                      {" · "}
                      {session.exerciseCount}{" "}
                      {session.exerciseCount === 1 ? "exercise" : "exercises"}
                      {" · "}
                      {session.setCount} {session.setCount === 1 ? "set" : "sets"}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {NUMBER_FORMAT.format(session.totalVolumeLbs)} lb volume
                      {session.durationMinutes !== null ? ` · ${session.durationMinutes} min` : ""}
                    </span>
                  </span>
                  <ChevronRight
                    className="size-5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}

      {(mode.kind === "view" || mode.kind === "edit") && activeSession === undefined ? (
        <div className="space-y-3" role="status" aria-label="Loading lifting session">
          <Skeleton className="h-48 w-full rounded-xl motion-reduce:animate-none" />
          <Skeleton className="h-32 w-full rounded-xl motion-reduce:animate-none" />
        </div>
      ) : null}

      {(mode.kind === "view" || mode.kind === "edit") && activeSession === null ? (
        <Alert variant="destructive">
          <AlertTitle>Session unavailable</AlertTitle>
          <AlertDescription>
            This lifting session may have been deleted or is no longer available.
          </AlertDescription>
          <Button type="button" variant="outline" className="mt-3 h-11" onClick={showList}>
            Back to sessions
          </Button>
        </Alert>
      ) : null}

      {mode.kind === "view" && activeSession ? (
        <LiftingSessionDetail
          session={activeSession}
          onEdit={() => setMode({ kind: "edit", sessionId: mode.sessionId })}
          onDeleted={showList}
        />
      ) : null}

      {mode.kind === "edit" && activeSession ? (
        <LiftingSessionForm
          key={`${activeSession.sessionId}:${activeSession.updatedAt}`}
          initialDraft={createLiftingDraftFromDetail(activeSession)}
          target={createLiftingReplaceTarget(activeSession)}
          onCancel={() => setMode({ kind: "view", sessionId: mode.sessionId })}
          onSaved={(session) => setMode({ kind: "view", sessionId: session.sessionId })}
        />
      ) : null}
    </div>
  );
}
