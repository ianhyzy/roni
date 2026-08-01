import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

const RECENT_NUTRITION_DAYS_LIMIT = 7;

export interface NutritionDaySnapshot {
  readonly calendarDate: string;
  readonly caloriesKcal?: number;
  readonly proteinGrams?: number;
  readonly carbsGrams?: number;
  readonly fatGrams?: number;
  readonly updatedAt: number;
}

export interface NutritionTargetsSnapshot {
  readonly caloriesKcal?: number;
  readonly proteinGrams?: number;
  readonly carbsGrams?: number;
  readonly fatGrams?: number;
}

export interface NutritionSnapshot {
  readonly days: ReadonlyArray<NutritionDaySnapshot>;
  readonly targets: NutritionTargetsSnapshot | null;
}

export async function readNutritionSnapshot(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<NutritionSnapshot> {
  const [days, targets] = await Promise.all([
    ctx.db
      .query("nutritionDailyLogs")
      .withIndex("by_userId_and_calendarDate", (q) => q.eq("userId", userId))
      .order("desc")
      .take(RECENT_NUTRITION_DAYS_LIMIT),
    ctx.db
      .query("nutritionTargets")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique(),
  ]);

  return {
    days: days.map((day) => ({
      calendarDate: day.calendarDate,
      ...(day.caloriesKcal !== undefined ? { caloriesKcal: day.caloriesKcal } : {}),
      ...(day.proteinGrams !== undefined ? { proteinGrams: day.proteinGrams } : {}),
      ...(day.carbsGrams !== undefined ? { carbsGrams: day.carbsGrams } : {}),
      ...(day.fatGrams !== undefined ? { fatGrams: day.fatGrams } : {}),
      updatedAt: day.updatedAt,
    })),
    targets: targets
      ? {
          ...(targets.caloriesKcal !== undefined ? { caloriesKcal: targets.caloriesKcal } : {}),
          ...(targets.proteinGrams !== undefined ? { proteinGrams: targets.proteinGrams } : {}),
          ...(targets.carbsGrams !== undefined ? { carbsGrams: targets.carbsGrams } : {}),
          ...(targets.fatGrams !== undefined ? { fatGrams: targets.fatGrams } : {}),
        }
      : null,
  };
}
