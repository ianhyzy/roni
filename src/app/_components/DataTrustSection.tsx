import Link from "next/link";

const DATA_SOURCES = [
  {
    name: "Tonal",
    use: "Training history, strength context, and approved workout delivery.",
    status: "Core connection",
  },
  {
    name: "Fitbit",
    use: "Optional read-only activity, health metrics, and sleep context.",
    status: "Provider review",
  },
  {
    name: "Garmin",
    use: "Optional activity and recovery context, plus approved workout delivery.",
    status: "Provider review",
  },
] as const;

export function DataTrustSection() {
  return (
    <section className="border-t border-border px-6 py-20 sm:py-28">
      <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[0.8fr_1.2fr]">
        <div>
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-primary">
            Useful context. Explicit boundaries.
          </p>
          <h2 className="mt-5 text-4xl font-bold tracking-[-0.035em] text-foreground">
            Your training data works for you.
          </h2>
          <p className="mt-5 text-lg leading-8 text-muted-foreground">
            Connected data is used to coach you—not to advertise to you. You can disconnect a
            provider, delete imported data, and review every workout before it leaves Roni.
          </p>
          <Link
            href="/privacy"
            className="mt-7 inline-flex text-sm font-semibold text-primary underline decoration-primary/40 underline-offset-4 hover:text-foreground"
          >
            Read the full data policy
          </Link>
        </div>

        <div className="divide-y divide-border rounded-2xl border border-border bg-card">
          {DATA_SOURCES.map(({ name, use, status }) => (
            <div
              key={name}
              className="grid gap-3 px-6 py-5 sm:grid-cols-[100px_1fr_auto] sm:items-center"
            >
              <p className="font-semibold text-foreground">{name}</p>
              <p className="text-sm leading-6 text-muted-foreground">{use}</p>
              <span className="w-fit rounded-full border border-border bg-background px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                {status}
              </span>
            </div>
          ))}
          <p className="px-6 py-4 text-xs leading-5 text-muted-foreground">
            Optional Fitbit and Garmin features remain subject to their providers&apos; approval and
            may not be available to every account.
          </p>
        </div>
      </div>
    </section>
  );
}
