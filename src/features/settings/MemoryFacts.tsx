"use client";

import { useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

type MemoryFact = FunctionReturnType<typeof api.userMemoryFacts.listMine>[number];

const CATEGORY_LABELS = {
  exercise_preference: "Exercise",
  schedule_preference: "Schedule",
  workout_style_preference: "Workout style",
} satisfies Record<MemoryFact["category"], string>;

const REMOVE_ERROR_MESSAGE = "Roni couldn't remove this memory. Try again.";

export function MemoryFacts() {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const facts = useQuery(api.userMemoryFacts.listMine, isAuthenticated ? {} : "skip");
  const removeFact = useMutation(api.userMemoryFacts.removeMine);
  const [confirmationFactId, setConfirmationFactId] = useState<MemoryFact["id"] | null>(null);
  const [pendingFactId, setPendingFactId] = useState<MemoryFact["id"] | null>(null);
  const [removalErrorFactId, setRemovalErrorFactId] = useState<MemoryFact["id"] | null>(null);

  async function handleRemove(factId: MemoryFact["id"]) {
    setPendingFactId(factId);
    setRemovalErrorFactId(null);

    try {
      const result = await removeFact({ factId });
      if (!result.removed) {
        setRemovalErrorFactId(factId);
        toast.error(REMOVE_ERROR_MESSAGE);
        return;
      }

      setConfirmationFactId(null);
      toast.success("Memory removed");
    } catch {
      setRemovalErrorFactId(factId);
      toast.error(REMOVE_ERROR_MESSAGE);
    } finally {
      setPendingFactId(null);
    }
  }

  if (isAuthLoading || !isAuthenticated || facts === undefined) {
    return (
      <Card>
        <CardContent className="space-y-3 p-4" role="status" aria-label="Loading coach memories">
          <Skeleton className="h-4 w-3/4 motion-reduce:animate-none" />
          <Skeleton className="h-14 w-full motion-reduce:animate-none" />
          <span className="sr-only">Loading coach memories</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">
          Roni remembers preferences you share to personalize future coaching. Remove anything you
          no longer want used.
        </p>

        {facts.length === 0 ? (
          <p className="rounded-lg bg-muted/50 px-3 py-4 text-sm text-muted-foreground">
            No saved coaching preferences yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {facts.map((fact) => {
              const isPending = pendingFactId === fact.id;

              return (
                <li
                  key={fact.id}
                  className="flex items-start justify-between gap-3 rounded-lg border px-3 py-3"
                >
                  <div className="min-w-0 space-y-2">
                    <Badge variant="secondary">{CATEGORY_LABELS[fact.category]}</Badge>
                    <p className="break-words text-sm text-foreground">{fact.fact}</p>
                  </div>

                  <Dialog
                    open={confirmationFactId === fact.id}
                    onOpenChange={(open) => {
                      if (!open && isPending) return;
                      setRemovalErrorFactId(null);
                      setConfirmationFactId(open ? fact.id : null);
                    }}
                  >
                    <DialogTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-11 min-w-11 shrink-0 text-muted-foreground hover:text-destructive sm:min-h-7 sm:min-w-0"
                          aria-label={`Forget memory: ${fact.fact}`}
                          disabled={isPending}
                        />
                      }
                    >
                      {isPending ? (
                        <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                      ) : (
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      )}
                      <span className="hidden sm:inline">Forget</span>
                    </DialogTrigger>
                    <DialogContent showCloseButton={!isPending}>
                      <DialogHeader>
                        <DialogTitle>Forget this memory?</DialogTitle>
                        <DialogDescription>
                          Roni will stop using this preference in future coaching.
                        </DialogDescription>
                      </DialogHeader>
                      <p className="rounded-lg bg-muted/50 px-3 py-3 text-sm text-foreground">
                        {fact.fact}
                      </p>
                      {removalErrorFactId === fact.id ? (
                        <p className="text-sm text-destructive" role="alert">
                          {REMOVE_ERROR_MESSAGE}
                        </p>
                      ) : null}
                      <DialogFooter>
                        <DialogClose
                          render={
                            <Button
                              variant="outline"
                              className="min-h-11 sm:min-h-8"
                              disabled={isPending}
                            />
                          }
                        >
                          Cancel
                        </DialogClose>
                        <Button
                          variant="destructive"
                          className="min-h-11 sm:min-h-8"
                          disabled={isPending}
                          onClick={() => handleRemove(fact.id)}
                        >
                          {isPending ? (
                            <Loader2
                              className="size-3.5 motion-safe:animate-spin"
                              aria-hidden="true"
                            />
                          ) : null}
                          Forget memory
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
