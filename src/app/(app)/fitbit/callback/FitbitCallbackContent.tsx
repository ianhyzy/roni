"use client";

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAction } from "convex/react";
import { Loader2 } from "lucide-react";
import { api } from "../../../../../convex/_generated/api";

export function FitbitCallbackContent() {
  const router = useRouter();
  const params = useSearchParams();
  const completeOAuth = useAction(api.fitbit.oauthFlow.completeFitbitOAuth);
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;

    const ticket = params.get("ticket")?.trim();

    if (!ticket) {
      router.replace("/settings?fitbit=error&reason=missing_params");
      return;
    }

    completeOAuth({ ticket })
      .then((result) => {
        if (result.success) {
          router.replace("/settings?fitbit=connected");
          return;
        }

        const reason = encodeURIComponent(result.error);
        router.replace(`/settings?fitbit=error&reason=${reason}`);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown error";
        const reason = encodeURIComponent(message);
        router.replace(`/settings?fitbit=error&reason=${reason}`);
      });
  }, [completeOAuth, params, router]);

  return (
    <div
      className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-6 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <p className="text-sm">Linking your Fitbit account…</p>
    </div>
  );
}
