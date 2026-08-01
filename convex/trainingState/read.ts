import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { RecoveryCheckInSignal, RecoveryInputs, RecoveryObservation } from "./types";

const RECOVERY_HISTORY_LIMIT = 7;

export interface RecoveryReadResult {
  activeFitbitGeneration: string | null;
  inputs: RecoveryInputs;
}

async function readOrFallback<T>(
  read: () => Promise<T>,
  fallback: T,
  sourceName: string,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.error(`readRecoveryInputs: ${sourceName} read failed`, error);
    return fallback;
  }
}

function garminObservation(row: Doc<"garminWellnessDaily">): RecoveryObservation {
  return {
    source: "garmin",
    calendarDate: row.calendarDate,
    ingestedAt: row.lastIngestedAt,
    ...(row.sleepDurationSeconds !== undefined
      ? { sleepDurationSeconds: row.sleepDurationSeconds }
      : {}),
    ...(row.sleepScore !== undefined ? { sleepScore: row.sleepScore } : {}),
    ...(row.hrvLastNightAvg !== undefined ? { hrvMilliseconds: row.hrvLastNightAvg } : {}),
    ...(row.hrvStatus !== undefined ? { hrvStatus: row.hrvStatus } : {}),
    ...(row.avgStress !== undefined ? { avgStress: row.avgStress } : {}),
    ...(row.bodyBatteryHighestValue !== undefined
      ? { bodyBatteryHighestValue: row.bodyBatteryHighestValue }
      : {}),
    ...(row.bodyBatteryLowestValue !== undefined
      ? { bodyBatteryLowestValue: row.bodyBatteryLowestValue }
      : {}),
    ...(row.restingHeartRate !== undefined ? { restingHeartRate: row.restingHeartRate } : {}),
    ...(row.avgSpo2 !== undefined ? { avgSpo2: row.avgSpo2 } : {}),
    ...(row.avgRespirationRate !== undefined ? { avgRespirationRate: row.avgRespirationRate } : {}),
    ...(row.skinTempDeviationCelsius !== undefined
      ? { skinTempDeviationCelsius: row.skinTempDeviationCelsius }
      : {}),
  };
}

function fitbitObservation(row: Doc<"fitbitWellnessDaily">): RecoveryObservation {
  return {
    source: "fitbit",
    calendarDate: row.calendarDate,
    ingestedAt: row.lastIngestedAt,
    ...(row.sleepDurationSeconds !== undefined
      ? { sleepDurationSeconds: row.sleepDurationSeconds }
      : {}),
    ...(row.averageHrvMilliseconds !== undefined
      ? { hrvMilliseconds: row.averageHrvMilliseconds }
      : {}),
    ...(row.restingHeartRate !== undefined ? { restingHeartRate: row.restingHeartRate } : {}),
  };
}

function checkInSignal(row: Doc<"recoveryCheckIns">): RecoveryCheckInSignal {
  return {
    calendarDate: row.calendarDate,
    energy: row.energy,
    soreness: row.soreness,
    stress: row.stress,
    ...(row.notes !== undefined ? { notes: row.notes } : {}),
    updatedAt: row.updatedAt,
  };
}

export async function readRecoveryInputs(
  ctx: Pick<QueryCtx, "db">,
  userId: Id<"users">,
): Promise<RecoveryReadResult> {
  const [profile, garminConnection, fitbitConnection, checkIns] = await Promise.all([
    readOrFallback<Doc<"userProfiles"> | null>(
      () =>
        ctx.db
          .query("userProfiles")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .unique(),
      null,
      "profile",
    ),
    readOrFallback<Doc<"garminConnections"> | null>(
      () =>
        ctx.db
          .query("garminConnections")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .unique(),
      null,
      "garminConnection",
    ),
    readOrFallback<Doc<"fitbitConnections"> | null>(
      () =>
        ctx.db
          .query("fitbitConnections")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .unique(),
      null,
      "fitbitConnection",
    ),
    readOrFallback<Doc<"recoveryCheckIns">[]>(
      () =>
        ctx.db
          .query("recoveryCheckIns")
          .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", userId))
          .order("desc")
          .take(RECOVERY_HISTORY_LIMIT),
      [],
      "checkIns",
    ),
  ]);

  const activeFitbitGeneration =
    fitbitConnection?.status === "active" ? fitbitConnection.generation : null;
  const [garminRows, fitbitRows] = await Promise.all([
    garminConnection?.status === "active"
      ? readOrFallback<Doc<"garminWellnessDaily">[]>(
          () =>
            ctx.db
              .query("garminWellnessDaily")
              .withIndex("by_userId_calendarDate", (q) => q.eq("userId", userId))
              .order("desc")
              .take(RECOVERY_HISTORY_LIMIT),
          [],
          "garminWellness",
        )
      : Promise.resolve([]),
    activeFitbitGeneration
      ? readOrFallback<Doc<"fitbitWellnessDaily">[]>(
          () =>
            ctx.db
              .query("fitbitWellnessDaily")
              .withIndex("by_userId_and_generation_and_calendarDate", (q) =>
                q.eq("userId", userId).eq("generation", activeFitbitGeneration),
              )
              .order("desc")
              .take(RECOVERY_HISTORY_LIMIT),
          [],
          "fitbitWellness",
        )
      : Promise.resolve([]),
  ]);

  return {
    activeFitbitGeneration,
    inputs: {
      preferredSource: profile?.preferredRecoverySource ?? null,
      observations: [...garminRows.map(garminObservation), ...fitbitRows.map(fitbitObservation)],
      checkIns: checkIns.map(checkInSignal),
    },
  };
}
