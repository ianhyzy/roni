export function Signal({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone: "cyan" | "violet" | "green";
}) {
  const dotClass = {
    cyan: "bg-primary",
    violet: "bg-violet-400",
    green: "bg-emerald-400",
  }[tone];

  return (
    <div>
      <p className="flex items-center gap-2 font-mono text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className={`size-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
        {label}
      </p>
      <p className="mt-1 pl-3.5 text-sm font-semibold text-foreground">{value}</p>
    </div>
  );
}
