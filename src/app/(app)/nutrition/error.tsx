"use client";

import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function NutritionError({ reset }: { reset: () => void }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6 lg:py-10">
      <Alert variant="destructive">
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>Could not load nutrition tracking</AlertTitle>
        <AlertDescription>
          Your saved logs are still safe. Try loading them again, or return to the dashboard.
        </AlertDescription>
      </Alert>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
        <Button type="button" className="h-11" onClick={reset}>
          <RotateCcw aria-hidden="true" />
          Try again
        </Button>
        <Button
          nativeButton={false}
          render={<Link href="/dashboard" />}
          variant="outline"
          className="h-11"
        >
          Back to dashboard
        </Button>
      </div>
    </div>
  );
}
