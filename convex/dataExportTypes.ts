import type { Doc } from "./_generated/dataModel";
import type { LiftingExportData } from "./liftingExport";
import type { NutritionExportData } from "./nutritionExport";
import type { RecoveryExportData } from "./recoveryExport";
import type { JsonExportSectionKey } from "./userData";

type UserMetadata = "_id" | "_creationTime" | "userId";
type GarminWorkoutDeliveryExportRow = Omit<Doc<"garminWorkoutDeliveries">, UserMetadata>;
type GarminWellnessDailyExportRow = Omit<Doc<"garminWellnessDaily">, UserMetadata>;
type FitbitWellnessDailyExportRow = Omit<Doc<"fitbitWellnessDaily">, UserMetadata>;

export interface ExportedData extends Record<
  JsonExportSectionKey | "exportedAt" | "user",
  unknown
> {
  exportedAt: string;
  user: { email: string | null; name: string | null };
  profile: {
    profileData: Record<string, unknown> | null;
    tonalConnectedAt: number | null;
    checkInPreferences: Record<string, unknown> | null;
    preferredRecoverySource: "garmin" | "fitbit" | null;
    ignoreAiProviderBudget: boolean | null;
    aiProviderBudgetLimitsUsd: NonNullable<Doc<"userProfiles">["aiProviderBudgetLimitsUsd"]> | null;
    lastActiveAt: number;
  } | null;
  workoutPlans: Record<string, unknown>[];
  weekPlans: Record<string, unknown>[];
  checkIns: Record<string, unknown>[];
  recoveryCheckIns: RecoveryExportData["recoveryCheckIns"];
  completedWorkouts: {
    date: string;
    title: string;
    targetArea: string;
    totalDuration: number;
    totalVolume: number;
    totalWork: number;
    workoutType: string;
  }[];
  exercisePerformance: {
    date: string;
    exerciseName: string;
    movementId: string;
    sets: number;
    totalReps: number;
    avgWeightLbs: number | null;
    totalVolume: number | null;
  }[];
  strengthScoreSnapshots: {
    date: string;
    overall: number;
    upper: number;
    lower: number;
    core: number;
  }[];
  currentStrengthScores: {
    bodyRegion: string;
    score: number;
  }[];
  muscleReadiness: {
    chest: number;
    shoulders: number;
    back: number;
    triceps: number;
    biceps: number;
    abs: number;
    obliques: number;
    quads: number;
    glutes: number;
    hamstrings: number;
    calves: number;
  } | null;
  externalActivities: {
    workoutType: string;
    beginTime: string;
    totalDuration: number;
    activeCalories: number;
    totalCalories: number;
    averageHeartRate: number;
    source: string;
    distance: number;
  }[];
  exerciseExclusions: {
    movementId: string;
    movementName: string;
    muscleGroups: string[];
    createdAt: number;
  }[];
  memoryFacts: {
    fact: string;
    category: string;
    confidence: number;
    createdAt: number;
    lastReferencedAt: number;
  }[];
  garminWorkoutDeliveries: GarminWorkoutDeliveryExportRow[];
  garminWellnessDaily: GarminWellnessDailyExportRow[];
  fitbitWellnessDaily: FitbitWellnessDailyExportRow[];
  liftingSessions: LiftingExportData["liftingSessions"];
  nutritionDailyLogs: NutritionExportData["nutritionDailyLogs"];
  nutritionTargets: NutritionExportData["nutritionTargets"];
}
