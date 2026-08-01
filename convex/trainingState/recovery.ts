import type {
  RecoveryCheckInSignal,
  RecoveryInputs,
  RecoveryMetrics,
  RecoveryObservation,
  RecoveryProviderSource,
  RecoveryReason,
  RecoveryState,
} from "./types";

const RECOVERY_FRESHNESS_MS = 36 * 60 * 60 * 1000;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;
const SHORT_SLEEP_SECONDS = 6 * 60 * 60;
const LOW_BODY_BATTERY = 30;
const MAX_HISTORY_ROWS = 7;

export interface DeriveRecoveryStateOptions {
  now: number;
  currentCalendarDate: string;
  inputs: RecoveryInputs;
}

function calendarDayDifference(currentDate: string, observedDate: string): number {
  const current = Date.parse(`${currentDate}T00:00:00.000Z`);
  const observed = Date.parse(`${observedDate}T00:00:00.000Z`);
  if (!Number.isFinite(current) || !Number.isFinite(observed)) return Number.POSITIVE_INFINITY;
  return Math.round((current - observed) / (24 * 60 * 60 * 1000));
}

function isFreshTimestamp(timestamp: number, now: number): boolean {
  const age = now - timestamp;
  return age >= -FUTURE_TIMESTAMP_TOLERANCE_MS && age <= RECOVERY_FRESHNESS_MS;
}

function isFreshCheckIn(
  timestamp: number,
  calendarDate: string,
  now: number,
  currentDate: string,
): boolean {
  const dayDifference = calendarDayDifference(currentDate, calendarDate);
  return isFreshTimestamp(timestamp, now) && dayDifference >= 0 && dayDifference <= 1;
}

function compareObservations(left: RecoveryObservation, right: RecoveryObservation): number {
  return (
    right.ingestedAt - left.ingestedAt ||
    (left.source === right.source ? 0 : left.source === "garmin" ? -1 : 1) ||
    right.calendarDate.localeCompare(left.calendarDate)
  );
}

function compareCheckIns(left: RecoveryCheckInSignal, right: RecoveryCheckInSignal): number {
  return right.updatedAt - left.updatedAt || right.calendarDate.localeCompare(left.calendarDate);
}

function selectObservation(
  observations: readonly RecoveryObservation[],
  preferredSource: RecoveryProviderSource | null,
  now: number,
): RecoveryObservation | null {
  const fresh = observations
    .filter((row) => isFreshTimestamp(row.ingestedAt, now))
    .sort(compareObservations);
  const preferred = preferredSource ? fresh.find((row) => row.source === preferredSource) : null;
  return preferred ?? fresh[0] ?? null;
}

function selectHistorySource(
  observations: readonly RecoveryObservation[],
  preferredSource: RecoveryProviderSource | null,
  selected: RecoveryObservation | null,
): RecoveryProviderSource | null {
  if (selected) return selected.source;
  if (preferredSource && observations.some((row) => row.source === preferredSource)) {
    return preferredSource;
  }
  return [...observations].sort(compareObservations)[0]?.source ?? null;
}

function metricsFromObservation(observation: RecoveryObservation | null): RecoveryMetrics {
  if (!observation) return {};
  return {
    ...(observation.sleepDurationSeconds !== undefined
      ? { sleepHours: observation.sleepDurationSeconds / 3600 }
      : {}),
    ...(observation.sleepScore !== undefined ? { sleepScore: observation.sleepScore } : {}),
    ...(observation.hrvMilliseconds !== undefined
      ? { hrvMilliseconds: observation.hrvMilliseconds }
      : {}),
    ...(observation.hrvStatus !== undefined ? { hrvStatus: observation.hrvStatus } : {}),
    ...(observation.avgStress !== undefined ? { avgStress: observation.avgStress } : {}),
    ...(observation.bodyBatteryHighestValue !== undefined
      ? { bodyBatteryHighestValue: observation.bodyBatteryHighestValue }
      : {}),
    ...(observation.bodyBatteryLowestValue !== undefined
      ? { bodyBatteryLowestValue: observation.bodyBatteryLowestValue }
      : {}),
    ...(observation.restingHeartRate !== undefined
      ? { restingHeartRate: observation.restingHeartRate }
      : {}),
    ...(observation.avgSpo2 !== undefined ? { avgSpo2: observation.avgSpo2 } : {}),
    ...(observation.avgRespirationRate !== undefined
      ? { avgRespirationRate: observation.avgRespirationRate }
      : {}),
    ...(observation.skinTempDeviationCelsius !== undefined
      ? { skinTempDeviationCelsius: observation.skinTempDeviationCelsius }
      : {}),
  };
}

function cautionReasons(
  observation: RecoveryObservation | null,
  checkIn: RecoveryCheckInSignal | null,
): RecoveryReason[] {
  const reasons: RecoveryReason[] = [];
  if (
    observation?.sleepDurationSeconds !== undefined &&
    observation.sleepDurationSeconds < SHORT_SLEEP_SECONDS
  ) {
    reasons.push("short_sleep");
  }
  const hrvStatus = observation?.hrvStatus?.trim().toUpperCase();
  if (observation?.source === "garmin" && (hrvStatus === "LOW" || hrvStatus === "POOR")) {
    reasons.push("low_hrv_status");
  }
  if (
    observation?.source === "garmin" &&
    observation.bodyBatteryHighestValue !== undefined &&
    observation.bodyBatteryHighestValue < LOW_BODY_BATTERY
  ) {
    reasons.push("low_body_battery");
  }
  if (checkIn && checkIn.energy <= 2) reasons.push("low_energy");
  if (checkIn && checkIn.soreness >= 4) reasons.push("high_soreness");
  return reasons;
}

export function deriveRecoveryState(options: DeriveRecoveryStateOptions): RecoveryState {
  const { now, currentCalendarDate, inputs } = options;
  const observation = selectObservation(inputs.observations, inputs.preferredSource, now);
  const checkIn =
    [...inputs.checkIns]
      .sort(compareCheckIns)
      .find((row) => isFreshCheckIn(row.updatedAt, row.calendarDate, now, currentCalendarDate)) ??
    null;
  const historySource = selectHistorySource(
    inputs.observations,
    inputs.preferredSource,
    observation,
  );
  const history = historySource
    ? inputs.observations
        .filter((row) => row.source === historySource)
        .sort(compareObservations)
        .slice(0, MAX_HISTORY_ROWS)
    : [];

  if (!observation && !checkIn) {
    return {
      status: "unknown",
      confidence: "low",
      source: null,
      observedDate: null,
      reasons: ["no_fresh_data"],
      metrics: {},
      checkIn: null,
      history,
    };
  }

  const reasons = cautionReasons(observation, checkIn);
  const metrics: RecoveryMetrics = {
    ...metricsFromObservation(observation),
    ...(checkIn
      ? { energy: checkIn.energy, soreness: checkIn.soreness, stress: checkIn.stress }
      : {}),
  };

  return {
    status: reasons.length > 0 ? "caution" : "normal",
    confidence: observation && checkIn ? "high" : observation ? "medium" : "low",
    source: observation?.source ?? "manual",
    observedDate: observation?.calendarDate ?? checkIn?.calendarDate ?? null,
    reasons,
    metrics,
    checkIn,
    history,
  };
}
