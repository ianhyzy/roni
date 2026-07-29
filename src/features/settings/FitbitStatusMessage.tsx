"use client";

import { CheckCircle2, Info, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export type FitbitConnectionNotice = {
  kind: "success" | "error" | "warning";
  message: string;
};

export function FitbitStatusMessage({ notice }: { notice: FitbitConnectionNotice }) {
  const isError = notice.kind === "error";
  const isWarning = notice.kind === "warning";
  const Icon = isError ? TriangleAlert : isWarning ? Info : CheckCircle2;

  return (
    <Alert
      variant={isError ? "destructive" : "default"}
      className={cn(
        "mt-3",
        isWarning && "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
      )}
      aria-live={isError ? "assertive" : "polite"}
    >
      <Icon className="size-4" aria-hidden="true" />
      <AlertDescription className={cn(isWarning && "text-amber-900 dark:text-amber-200")}>
        {notice.message}
      </AlertDescription>
    </Alert>
  );
}
