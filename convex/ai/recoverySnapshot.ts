import type {
  RecoveryMetrics,
  RecoveryObservation,
  RecoveryReason,
  RecoveryState,
} from "../trainingState/types";

const REASON_LABELS: Readonly<Record<RecoveryReason, string>> = {
  no_fresh_data: "no fresh data",
  short_sleep: "short sleep",
  low_hrv_status: "low HRV status",
  low_body_battery: "low body battery",
  low_energy: "low energy",
  high_soreness: "high soreness",
};

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatMetrics(metrics: RecoveryMetrics): string[] {
  const parts: string[] = [];
  if (metrics.sleepHours !== undefined) parts.push(`sleep ${formatNumber(metrics.sleepHours)}h`);
  if (metrics.sleepScore !== undefined) parts.push(`sleep score ${Math.round(metrics.sleepScore)}`);
  if (metrics.hrvMilliseconds !== undefined) {
    parts.push(`HRV ${formatNumber(metrics.hrvMilliseconds)}ms`);
  }
  if (metrics.hrvStatus !== undefined) parts.push(`HRV status ${metrics.hrvStatus}`);
  if (metrics.avgStress !== undefined)
    parts.push(`provider stress ${Math.round(metrics.avgStress)}`);
  if (
    metrics.bodyBatteryLowestValue !== undefined ||
    metrics.bodyBatteryHighestValue !== undefined
  ) {
    parts.push(
      `body battery ${metrics.bodyBatteryLowestValue ?? "?"}-${metrics.bodyBatteryHighestValue ?? "?"}`,
    );
  }
  if (metrics.restingHeartRate !== undefined) {
    parts.push(`RHR ${Math.round(metrics.restingHeartRate)}`);
  }
  return parts;
}

function metricsFromHistory(row: RecoveryObservation): RecoveryMetrics {
  return {
    ...(row.sleepDurationSeconds !== undefined
      ? { sleepHours: row.sleepDurationSeconds / 3600 }
      : {}),
    ...(row.hrvMilliseconds !== undefined ? { hrvMilliseconds: row.hrvMilliseconds } : {}),
    ...(row.restingHeartRate !== undefined ? { restingHeartRate: row.restingHeartRate } : {}),
  };
}

export function formatRecoveryLines(state: RecoveryState): string[] {
  if (state.status === "unknown" || state.source === null) return [];
  const source = state.source[0].toUpperCase() + state.source.slice(1);
  const lines = [`Recovery Signals (${source}) — ${state.status}, ${state.confidence} confidence:`];
  const currentMetrics = formatMetrics(state.metrics);
  if (currentMetrics.length > 0) lines.push(`  Current | ${currentMetrics.join(" | ")}`);
  for (const row of state.history) {
    if (row.calendarDate === state.observedDate) continue;
    const historyMetrics = formatMetrics(metricsFromHistory(row));
    if (historyMetrics.length > 0) {
      lines.push(`  ${row.calendarDate} | ${historyMetrics.join(" | ")}`);
    }
  }
  if (state.checkIn) {
    const { energy, soreness, stress, notes } = state.checkIn;
    lines.push(
      `  Check-in | energy ${energy}/5 | soreness ${soreness}/5 | stress ${stress}/5${notes ? ` | notes ${notes}` : ""}`,
    );
  }
  if (state.reasons.length > 0) {
    lines.push(`  Caution: ${state.reasons.map((reason) => REASON_LABELS[reason]).join("; ")}`);
  }
  lines.push(
    "  Treat these as training-readiness signals, not a medical diagnosis; use caution to reduce intensity or volume when appropriate.",
  );
  return lines;
}
