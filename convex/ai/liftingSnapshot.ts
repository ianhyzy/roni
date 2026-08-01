import type { LiftingSessionSnapshot } from "../liftingCoachProjection";
import type { SnapshotSection } from "./snapshotHelpers";
import { getRecencyLabel } from "./timeDecay";

const numberFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

interface FormatLiftingSnapshotOptions {
  readonly sessions: ReadonlyArray<LiftingSessionSnapshot>;
  readonly now: Date;
  readonly userTimezone?: string;
}

function pluralize(count: number, singular: string): string {
  return `${numberFormatter.format(count)} ${singular}${count === 1 ? "" : "s"}`;
}

export function formatLiftingSnapshot({
  sessions,
  now,
  userTimezone,
}: FormatLiftingSnapshotOptions): SnapshotSection | null {
  if (sessions.length === 0) return null;

  const lines = ["Manual Lifting (non-Tonal):"];
  for (const session of sessions) {
    const recency = getRecencyLabel(new Date(session.performedAt).toISOString(), now, userTimezone);
    const duration =
      session.durationMinutes === undefined ? "" : ` | ${session.durationMinutes}min`;
    lines.push(
      `  [${recency.toUpperCase()}] ${session.calendarDate} | ${session.title}${duration} | ${pluralize(session.exerciseCount, "exercise")} | ${pluralize(session.setCount, "set")} | ${pluralize(session.totalReps, "rep")} | ${numberFormatter.format(session.totalVolumeLbs)}lbs vol`,
    );
    for (const exercise of session.exercises) {
      lines.push(
        `    ${exercise.name} | ${pluralize(exercise.setCount, "set")} | ${pluralize(exercise.totalReps, "rep")} | ${numberFormatter.format(exercise.totalVolumeLbs)}lbs vol`,
      );
    }
  }
  lines.push(
    "  general fatigue/volume context only; do not treat as Tonal PR, Strength Score, or progressive-overload evidence.",
  );
  return { priority: 6, lines };
}
