export type RecoveryProviderSource = "garmin" | "fitbit";
export type RecoverySource = RecoveryProviderSource | "manual";
export type RecoveryStatus = "unknown" | "normal" | "caution";
export type RecoveryConfidence = "low" | "medium" | "high";

export type RecoveryReason =
  | "no_fresh_data"
  | "short_sleep"
  | "low_hrv_status"
  | "low_body_battery"
  | "low_energy"
  | "high_soreness";

export interface RecoveryObservation {
  source: RecoveryProviderSource;
  calendarDate: string;
  ingestedAt: number;
  sleepDurationSeconds?: number;
  sleepScore?: number;
  hrvMilliseconds?: number;
  hrvStatus?: string;
  avgStress?: number;
  bodyBatteryHighestValue?: number;
  bodyBatteryLowestValue?: number;
  restingHeartRate?: number;
  avgSpo2?: number;
  avgRespirationRate?: number;
  skinTempDeviationCelsius?: number;
}

export interface RecoveryCheckInSignal {
  calendarDate: string;
  energy: number;
  soreness: number;
  stress: number;
  notes?: string;
  updatedAt: number;
}

export interface RecoveryInputs {
  preferredSource: RecoveryProviderSource | null;
  observations: readonly RecoveryObservation[];
  checkIns: readonly RecoveryCheckInSignal[];
}

export interface RecoveryMetrics {
  sleepHours?: number;
  sleepScore?: number;
  hrvMilliseconds?: number;
  hrvStatus?: string;
  avgStress?: number;
  bodyBatteryHighestValue?: number;
  bodyBatteryLowestValue?: number;
  restingHeartRate?: number;
  avgSpo2?: number;
  avgRespirationRate?: number;
  skinTempDeviationCelsius?: number;
  energy?: number;
  soreness?: number;
  stress?: number;
}

export interface RecoveryState {
  status: RecoveryStatus;
  confidence: RecoveryConfidence;
  source: RecoverySource | null;
  observedDate: string | null;
  reasons: readonly RecoveryReason[];
  metrics: RecoveryMetrics;
  checkIn: RecoveryCheckInSignal | null;
  history: readonly RecoveryObservation[];
}
