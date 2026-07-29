"use client";

import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

const LONG_WAIT_MS = 15_000;

export function ThinkingIndicator({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const remainingMs = LONG_WAIT_MS - (Date.now() - startedAt);
    if (remainingMs <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), remainingMs);
    return () => window.clearTimeout(timer);
  }, [startedAt]);

  const isLongWait = now - startedAt >= LONG_WAIT_MS;

  return (
    <div
      className="animate-in fade-in slide-in-from-bottom-2 px-4 pt-4 pb-2 duration-300 sm:px-6"
      role="status"
      aria-label={isLongWait ? "Roni is still working" : "Roni is preparing a response"}
    >
      <div className="mb-2 flex items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded-full bg-gradient-to-br from-primary to-[oklch(0.6_0.22_300)]">
          <Sparkles className="size-3 text-white" />
        </div>
        <span className="text-[13px] font-semibold text-foreground">Roni</span>
      </div>
      <div className="sm:pl-8">
        <div className="inline-flex items-center gap-2 rounded-2xl bg-muted/60 px-4 py-2.5">
          <div className="flex items-center gap-1">
            <span
              className="inline-block size-2 rounded-full bg-foreground/30 motion-safe:animate-[thinking-dot_1.4s_ease-in-out_infinite]"
              aria-hidden="true"
            />
            <span
              className="inline-block size-2 rounded-full bg-foreground/30 motion-safe:animate-[thinking-dot_1.4s_ease-in-out_0.2s_infinite]"
              aria-hidden="true"
            />
            <span
              className="inline-block size-2 rounded-full bg-foreground/30 motion-safe:animate-[thinking-dot_1.4s_ease-in-out_0.4s_infinite]"
              aria-hidden="true"
            />
          </div>
          {isLongWait && (
            <span className="animate-in fade-in text-xs text-muted-foreground duration-300">
              Taking longer than usual...
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
