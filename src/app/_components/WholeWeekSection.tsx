const PLAN_STEPS = [
  {
    label: "READ",
    heading: "See what your body already did",
    description:
      "Roni starts with completed Tonal sessions, strength trends, your schedule, and the goals and limitations you set.",
  },
  {
    label: "DECIDE",
    heading: "Program the week, not just the next workout",
    description:
      "Coach balances volume, recovery, cross-training, and missed sessions before proposing the next useful dose.",
  },
  {
    label: "DELIVER",
    heading: "Approve it, then train on Tonal",
    description:
      "Review the exercises, sets, reps, and targets. Nothing is sent to your machine until you approve it.",
  },
] as const;

export function WholeWeekSection() {
  return (
    <section id="week" className="border-b border-border px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:items-end">
          <div>
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-primary">
              One coach. The whole week.
            </p>
            <h2 className="mt-5 text-4xl font-bold tracking-[-0.035em] text-foreground sm:text-5xl">
              A plan should react to your life before you have to.
            </h2>
          </div>
          <p className="max-w-2xl text-lg leading-8 text-muted-foreground lg:justify-self-end">
            Most workout generators start from a blank prompt. Roni starts from the work already in
            your body, then keeps the plan useful when your schedule, performance, or recovery
            changes.
          </p>
        </div>

        <div className="mt-14 grid gap-px overflow-hidden rounded-2xl border border-border bg-border lg:grid-cols-3">
          {PLAN_STEPS.map(({ label, heading, description }) => (
            <article key={label} className="bg-card p-7 sm:p-8">
              <p className="font-mono text-[11px] font-semibold tracking-[0.22em] text-primary">
                {label}
              </p>
              <h3 className="mt-7 text-xl font-bold tracking-tight text-foreground">{heading}</h3>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
