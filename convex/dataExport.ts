import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import * as analytics from "./lib/posthog";
import type { Doc } from "./_generated/dataModel";
import type { Activity } from "./tonal/types";
import type { JsonExportSectionKey } from "./userData";
import { collectRecoveryExportData, type RecoveryExportData } from "./recoveryExport";
import { collectLiftingExportData, type LiftingExportData } from "./liftingExport";
import { collectNutritionExportData, type NutritionExportData } from "./nutritionExport";

type UserMetadata = "_id" | "_creationTime" | "userId";
type GarminWorkoutDeliveryExportRow = Omit<Doc<"garminWorkoutDeliveries">, UserMetadata>;
type GarminWellnessDailyExportRow = Omit<Doc<"garminWellnessDaily">, UserMetadata>;
type FitbitWellnessDailyExportRow = Omit<Doc<"fitbitWellnessDaily">, UserMetadata>;

interface ExportedData extends Record<JsonExportSectionKey | "exportedAt" | "user", unknown> {
  exportedAt: string;
  user: { email: string | null; name: string | null };
  profile: {
    profileData: Record<string, unknown> | null;
    tonalConnectedAt: number | null;
    checkInPreferences: Record<string, unknown> | null;
    preferredRecoverySource: "garmin" | "fitbit" | null;
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

/** Convert a Tonal API Activity to the completedWorkouts export format. */
function activityToExportRow(a: Activity) {
  const p = a.workoutPreview;
  return {
    date: a.activityTime.split("T")[0],
    title: p?.workoutTitle ?? "Unknown",
    targetArea: p?.targetArea ?? "",
    totalDuration: p?.totalDuration ?? 0,
    totalVolume: p?.totalVolume ?? 0,
    totalWork: p?.totalWork ?? 0,
    workoutType: p?.workoutType ?? "",
  };
}

function userDocumentToExportRow<
  T extends { _id: unknown; _creationTime: number; userId: unknown },
>(row: T): Omit<T, "_id" | "_creationTime" | "userId"> {
  const {
    _id: _unusedId,
    _creationTime: _unusedCreationTime,
    userId: _unusedUserId,
    ...exportRow
  } = row;
  return exportRow;
}

export const exportData = action({
  args: {},
  handler: async (ctx): Promise<ExportedData> => {
    const userId = await ctx.runQuery(internal.lib.auth.resolveEffectiveUserId, {});
    if (!userId) throw new Error("Not authenticated");

    const data = (await ctx.runQuery(internal.dataExport.collectUserData, {
      userId,
    })) as ExportedData;
    Object.assign(
      data,
      ...(await Promise.all([
        collectLiftingExportData(ctx, userId),
        collectNutritionExportData(ctx, userId),
      ])),
    );

    if (data.profile?.tonalConnectedAt) {
      try {
        const [knownIds, activities] = await Promise.all([
          ctx.runQuery(internal.dataExport.getKnownActivityIds, { userId }) as Promise<string[]>,
          ctx.runAction(internal.tonal.workoutHistoryProxy.fetchWorkoutHistory, {
            userId,
          }) as Promise<Activity[]>,
        ]);
        const knownSet = new Set(knownIds);
        for (const a of activities) {
          if (!knownSet.has(a.activityId)) {
            data.completedWorkouts.push(activityToExportRow(a));
          }
        }
        data.completedWorkouts.sort((a, b) => a.date.localeCompare(b.date));
      } catch (err) {
        console.warn("Tonal API unavailable during export — continuing with DB data only", err);
      }
    }

    analytics.capture(userId, "data_export_requested");
    await analytics.flush();

    return data;
  },
});

export const getKnownActivityIds = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const workouts = await ctx.db
      .query("completedWorkouts")
      .withIndex("by_userId_date", (q) => q.eq("userId", userId))
      .collect();
    return workouts.map((w) => w.activityId);
  },
});

export const collectUserData = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();

    const workoutPlans = await ctx.db
      .query("workoutPlans")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    const weekPlans = await ctx.db
      .query("weekPlans")
      .withIndex("by_userId_weekStartDate", (q) => q.eq("userId", userId))
      .collect();

    const checkIns = await ctx.db
      .query("checkIns")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    const completedWorkouts = await ctx.db
      .query("completedWorkouts")
      .withIndex("by_userId_date", (q) => q.eq("userId", userId))
      .collect();

    const exercisePerformanceRows = await ctx.db
      .query("exercisePerformance")
      .withIndex("by_userId_date", (q) => q.eq("userId", userId))
      .collect();

    const strengthScoreSnapshots = await ctx.db
      .query("strengthScoreSnapshots")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    const currentStrengthScores = await ctx.db
      .query("currentStrengthScores")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    const muscleReadinessRow = await ctx.db
      .query("muscleReadiness")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();

    const externalActivities = await ctx.db
      .query("externalActivities")
      .withIndex("by_userId_beginTime", (q) => q.eq("userId", userId))
      .collect();

    const exerciseExclusions = await ctx.db
      .query("exerciseExclusions")
      .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();

    const memoryFacts = await ctx.db
      .query("userMemoryFacts")
      .withIndex("by_userId_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();

    const garminWellnessDaily = await ctx.db
      .query("garminWellnessDaily")
      .withIndex("by_userId_calendarDate", (q) => q.eq("userId", userId))
      .collect();

    const garminWorkoutDeliveries = await ctx.db
      .query("garminWorkoutDeliveries")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .collect();

    const fitbitWellnessDaily = await ctx.db
      .query("fitbitWellnessDaily")
      .withIndex("by_userId_and_calendarDate", (q) => q.eq("userId", userId))
      .collect();
    const recoveryData = await collectRecoveryExportData(ctx, userId);

    // Build movement ID → name lookup, fetching only movements actually
    // referenced by this user's exercisePerformance rows.
    const movementIds = new Set(exercisePerformanceRows.map((ep) => ep.movementId));
    const referencedMovements = await Promise.all(
      [...movementIds].map((tonalId) =>
        ctx.db
          .query("movements")
          .withIndex("by_tonalId", (q) => q.eq("tonalId", tonalId))
          .unique(),
      ),
    );
    const movementNames = new Map<string, string>();
    for (const m of referencedMovements) {
      if (m) movementNames.set(m.tonalId, m.name);
    }

    return {
      exportedAt: new Date().toISOString(),
      user: {
        email: user?.email ?? null,
        name: user?.name ?? null,
      },
      profile: profile
        ? {
            profileData: profile.profileData ?? null,
            tonalConnectedAt: profile.tonalConnectedAt ?? null,
            checkInPreferences: profile.checkInPreferences ?? null,
            preferredRecoverySource: profile.preferredRecoverySource ?? null,
            lastActiveAt: profile.lastActiveAt,
          }
        : null,
      workoutPlans: workoutPlans.map((wp) => ({
        title: wp.title,
        status: wp.status,
        blocks: wp.blocks,
        estimatedDuration: wp.estimatedDuration ?? null,
        createdAt: wp.createdAt,
        pushedAt: wp.pushedAt ?? null,
      })),
      weekPlans: weekPlans.map((wp) => ({
        weekStartDate: wp.weekStartDate,
        preferredSplit: wp.preferredSplit,
        targetDays: wp.targetDays,
        days: wp.days,
        createdAt: wp.createdAt,
        updatedAt: wp.updatedAt,
      })),
      checkIns: checkIns.map((ci) => ({
        trigger: ci.trigger,
        message: ci.message,
        readAt: ci.readAt ?? null,
        createdAt: ci.createdAt,
        triggerContext: ci.triggerContext ?? null,
      })),
      completedWorkouts: completedWorkouts.map((cw) => ({
        date: cw.date,
        title: cw.title,
        targetArea: cw.targetArea,
        totalDuration: cw.totalDuration,
        totalVolume: cw.totalVolume,
        totalWork: cw.totalWork,
        workoutType: cw.workoutType,
      })),
      exercisePerformance: exercisePerformanceRows.map((ep) => ({
        date: ep.date,
        exerciseName: movementNames.get(ep.movementId) ?? ep.movementId,
        movementId: ep.movementId,
        sets: ep.sets,
        totalReps: ep.totalReps,
        avgWeightLbs: ep.avgWeightLbs ?? null,
        totalVolume: ep.totalVolume ?? null,
      })),
      strengthScoreSnapshots: strengthScoreSnapshots.map((ss) => ({
        date: ss.date,
        overall: ss.overall,
        upper: ss.upper,
        lower: ss.lower,
        core: ss.core,
      })),
      currentStrengthScores: currentStrengthScores.map((cs) => ({
        bodyRegion: cs.bodyRegion,
        score: cs.score,
      })),
      muscleReadiness: muscleReadinessRow
        ? {
            chest: muscleReadinessRow.chest,
            shoulders: muscleReadinessRow.shoulders,
            back: muscleReadinessRow.back,
            triceps: muscleReadinessRow.triceps,
            biceps: muscleReadinessRow.biceps,
            abs: muscleReadinessRow.abs,
            obliques: muscleReadinessRow.obliques,
            quads: muscleReadinessRow.quads,
            glutes: muscleReadinessRow.glutes,
            hamstrings: muscleReadinessRow.hamstrings,
            calves: muscleReadinessRow.calves,
          }
        : null,
      externalActivities: externalActivities.map((ea) => ({
        workoutType: ea.workoutType,
        beginTime: ea.beginTime,
        totalDuration: ea.totalDuration,
        activeCalories: ea.activeCalories,
        totalCalories: ea.totalCalories,
        averageHeartRate: ea.averageHeartRate,
        source: ea.source,
        distance: ea.distance,
      })),
      exerciseExclusions: exerciseExclusions.map((exclusion) => ({
        movementId: exclusion.movementId,
        movementName: exclusion.movementName,
        muscleGroups: exclusion.muscleGroups,
        createdAt: exclusion.createdAt,
      })),
      memoryFacts: memoryFacts.map((memoryFact) => ({
        fact: memoryFact.fact,
        category: memoryFact.category,
        confidence: memoryFact.confidence,
        createdAt: memoryFact.createdAt,
        lastReferencedAt: memoryFact.lastReferencedAt,
      })),
      garminWorkoutDeliveries: garminWorkoutDeliveries.map(userDocumentToExportRow),
      garminWellnessDaily: garminWellnessDaily.map(userDocumentToExportRow),
      fitbitWellnessDaily: fitbitWellnessDaily.map(userDocumentToExportRow),
      liftingSessions: [],
      nutritionDailyLogs: [],
      nutritionTargets: [],
      ...recoveryData,
    };
  },
});
