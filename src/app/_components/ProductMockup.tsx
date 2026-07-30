import { Signal } from "./Signal";

const WEEK_DAYS = [
  { day: "MON", session: "Upper strength", detail: "42 min · Tonal", status: "READY" },
  { day: "TUE", session: "Recovery", detail: "Mobility · Walk", status: "EASY" },
  { day: "WED", session: "Lower volume", detail: "48 min · Tonal", status: "ADAPTED" },
  { day: "FRI", session: "Full body", detail: "Coach draft", status: "REVIEW" },
] as const;

export function ProductMockup() {
  return (
    <div
      className="relative rounded-[28px] border border-border bg-card/95 p-3 shadow-2xl shadow-black/35"
      aria-label="Illustrative weekly plan in Roni"
    >
      <div className="rounded-[22px] border border-white/5 bg-background p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4 border-b border-border pb-5">
          <div>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
              Illustrative week
            </p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
              Built around what changed
            </h2>
          </div>
          <div className="rounded-full border border-emerald-400/25 bg-emerald-400/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
            On track
          </div>
        </div>

        <div className="grid gap-5 py-5 sm:grid-cols-[132px_1fr]">
          <div className="space-y-3 border-b border-border pb-5 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-5">
            <Signal label="Tonal volume" value="−8%" tone="cyan" />
            <Signal label="Sleep trend" value="7h 24m" tone="violet" />
            <Signal label="Cardio load" value="Moderate" tone="green" />
          </div>

          <div className="space-y-2">
            {WEEK_DAYS.map(({ day, session, detail, status }) => (
              <div
                key={day}
                className="grid grid-cols-[44px_1fr_auto] items-center gap-3 rounded-xl border border-border bg-card px-3 py-3"
              >
                <span className="font-mono text-[10px] font-semibold tracking-wider text-muted-foreground">
                  {day}
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">{session}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
                </div>
                <span className="font-mono text-[9px] font-semibold tracking-wider text-primary">
                  {status}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/20 bg-primary/[0.08] px-4 py-3">
          <p className="text-sm text-foreground">
            <span className="font-semibold">Coach:</span> Wednesday volume came down after Tuesday
            cardio and a shorter sleep night.
          </p>
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-primary">
            Review plan
          </span>
        </div>
      </div>
    </div>
  );
}
