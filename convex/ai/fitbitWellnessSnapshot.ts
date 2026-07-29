const SECONDS_PER_HOUR = 3600;
export const FITBIT_WELLNESS_SNAPSHOT_ROW_LIMIT = 7;

export interface FitbitWellnessSnapshotRow {
  calendarDate: string;
  sleepDurationSeconds?: number;
  restingHeartRate?: number;
  averageHrvMilliseconds?: number;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatFitbitWellnessLines(rows: readonly FitbitWellnessSnapshotRow[]): string[] {
  const lines = ["Fitbit Recovery Signals:"];
  for (const row of rows.slice(0, FITBIT_WELLNESS_SNAPSHOT_ROW_LIMIT)) {
    const parts: string[] = [];
    if (row.sleepDurationSeconds !== undefined) {
      parts.push(`sleep ${formatNumber(row.sleepDurationSeconds / SECONDS_PER_HOUR)}h`);
    }
    if (row.restingHeartRate !== undefined) {
      parts.push(`RHR ${Math.round(row.restingHeartRate)}`);
    }
    if (row.averageHrvMilliseconds !== undefined) {
      parts.push(`HRV ${formatNumber(row.averageHrvMilliseconds)}ms`);
    }
    if (parts.length > 0) lines.push(`  ${row.calendarDate} | ${parts.join(" | ")}`);
  }
  if (lines.length === 1) return [];
  lines.push(
    "  Use poor sleep, low HRV, or elevated resting HR to bias toward recovery or reduced volume.",
  );
  return lines;
}
