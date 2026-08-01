"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type RecoverySource = "garmin" | "fitbit";
type PreferenceValue = RecoverySource | null;

const OPTIONS: readonly { readonly value: PreferenceValue; readonly label: string }[] = [
  { value: null, label: "Automatic" },
  { value: "garmin", label: "Garmin" },
  { value: "fitbit", label: "Fitbit" },
];

export function RecoverySourcePreference() {
  const preference = useQuery(api.recoveryPreferences.getMine, {});
  const garminStatus = useQuery(api.garmin.connections.getMyGarminStatus, {});
  const fitbitStatus = useQuery(api.fitbit.connections.getMyFitbitStatus, {});
  const setPreference = useMutation(api.recoveryPreferences.setMine);
  const [isSaving, setIsSaving] = useState(false);

  if (preference === undefined || garminStatus === undefined || fitbitStatus === undefined) {
    return (
      <Card role="status" aria-label="Loading recovery source preference">
        <CardContent className="space-y-3 p-4">
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3].map((item) => (
              <div
                key={item}
                className="h-11 animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const availability: Record<RecoverySource, boolean> = {
    garmin: garminStatus.state === "active",
    fitbit: fitbitStatus.state === "active",
  };
  const staleSource =
    preference.preferredSource && !availability[preference.preferredSource]
      ? preference.preferredSource
      : null;

  const choose = async (preferredSource: PreferenceValue) => {
    if (preferredSource === preference.preferredSource || isSaving) return;
    if (preferredSource && !availability[preferredSource]) return;
    setIsSaving(true);
    try {
      await setPreference({ preferredSource });
      toast.success("Recovery source saved");
    } catch {
      toast.error("Could not save recovery source. Try again.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div>
          <p className="text-sm font-medium text-foreground">Choose the primary recovery source</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Automatic uses the freshest connected source. Roni never combines overlapping device
            recovery signals.
          </p>
        </div>

        <fieldset disabled={isSaving} aria-busy={isSaving}>
          <legend className="sr-only">Primary recovery source</legend>
          <div className="grid grid-cols-3 gap-2">
            {OPTIONS.map((option) => {
              const isAvailable = option.value === null || availability[option.value];
              const selected = preference.preferredSource === option.value;
              return (
                <div key={option.label} className="min-w-0 text-center">
                  <Button
                    type="button"
                    variant={selected ? "default" : "outline"}
                    className="h-11 w-full px-2"
                    aria-label={option.label}
                    aria-pressed={selected}
                    disabled={!isAvailable || isSaving}
                    onClick={() => choose(option.value)}
                  >
                    {option.label}
                  </Button>
                  <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
                    {option.value === null
                      ? "Always available"
                      : availability[option.value]
                        ? "Connected"
                        : "Not connected"}
                  </p>
                </div>
              );
            })}
          </div>
        </fieldset>

        <span className="sr-only" role="status" aria-live="polite">
          {isSaving ? "Saving recovery source" : ""}
        </span>

        {staleSource ? (
          <p
            role="status"
            className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          >
            {staleSource === "garmin" ? "Garmin" : "Fitbit"} is not currently connected. Roni will
            automatically use another fresh source until it reconnects, while keeping your
            preference.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
