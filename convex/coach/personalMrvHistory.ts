import {
  canonicalPersonalMrvMuscleGroup,
  estimatePersonalMrv,
  PERSONAL_MRV_REGION_BY_MUSCLE,
  type PersonalMrvEstimate,
  type PersonalMrvMuscleGroup,
  type PersonalMrvRegion,
  type SetStrengthObservation,
} from "./personalMrv";
import { VOLUME_LANDMARKS } from "./volumeLandmarks";

interface PerformanceRow {
  movementId: string;
  date: string;
  sets?: number;
}

interface StrengthSnapshot {
  date: string;
  upper: number;
  lower: number;
  core: number;
}

interface MovementMetadata {
  tonalId: string;
  muscleGroups: readonly string[];
}

export interface CompletedWorkoutProjection {
  date: string;
  performanceSyncComplete?: true;
}

export interface PersonalMrvHistoryInput {
  windowStartDate: string;
  windowEndDate: string;
  performanceRows: readonly PerformanceRow[];
  strengthSnapshots: readonly StrengthSnapshot[];
  movements: readonly MovementMetadata[];
  completedWorkouts: readonly CompletedWorkoutProjection[];
}

export type MusclePersonalMrvEstimate = {
  muscleGroup: PersonalMrvMuscleGroup;
  region: PersonalMrvRegion;
} & PersonalMrvEstimate;

function startOfUtcWeek(date: string): string | null {
  const isoDate = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== isoDate) return null;
  parsed.setUTCDate(parsed.getUTCDate() - ((parsed.getUTCDay() + 6) % 7));
  return parsed.toISOString().slice(0, 10);
}

function addUtcDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function movementMuscles(movement: MovementMetadata | undefined): PersonalMrvMuscleGroup[] {
  if (!movement) return [];
  return [
    ...new Set(
      movement.muscleGroups
        .map(canonicalPersonalMrvMuscleGroup)
        .filter((muscle): muscle is PersonalMrvMuscleGroup => muscle !== null),
    ),
  ];
}

function weeklyStrengthChanges({
  snapshots,
  region,
  windowStartDate,
  windowEndDate,
}: {
  snapshots: readonly StrengthSnapshot[];
  region: PersonalMrvRegion;
  windowStartDate: string;
  windowEndDate: string;
}): Map<string, number> {
  const latestByWeek = new Map<string, { date: string; score: number }>();
  for (const snapshot of snapshots) {
    const date = snapshot.date.slice(0, 10);
    if (date > windowEndDate) continue;
    const week = startOfUtcWeek(date);
    if (!week) continue;
    const score = snapshot[region];
    if (!Number.isFinite(score)) continue;
    const current = latestByWeek.get(week);
    if (!current || date > current.date) latestByWeek.set(week, { date, score });
  }

  const windowStartWeek = startOfUtcWeek(windowStartDate) ?? windowStartDate;
  const windowEndWeek = startOfUtcWeek(windowEndDate) ?? windowEndDate;
  const changes = new Map<string, number>();
  for (const [week, latest] of latestByWeek) {
    if (week < windowStartWeek || week > windowEndWeek) continue;
    const previous = latestByWeek.get(addUtcDays(week, -7));
    if (previous) changes.set(week, latest.score - previous.score);
  }
  return changes;
}

export function buildMusclePersonalMrvEstimates(
  input: PersonalMrvHistoryInput,
): MusclePersonalMrvEstimate[] {
  const movementById = new Map(input.movements.map((movement) => [movement.tonalId, movement]));
  const observedMuscles = new Set<PersonalMrvMuscleGroup>();
  for (const movement of input.movements) {
    for (const muscle of movementMuscles(movement)) observedMuscles.add(muscle);
  }
  if (observedMuscles.size === 0) return [];

  const incompleteProjectionWeeks = new Set<string>();
  for (const workout of input.completedWorkouts) {
    const date = workout.date.slice(0, 10);
    if (date < input.windowStartDate || date > input.windowEndDate) continue;
    const week = startOfUtcWeek(workout.date);
    if (week && workout.performanceSyncComplete !== true) {
      incompleteProjectionWeeks.add(week);
    }
  }

  const weeklySets = new Map<PersonalMrvMuscleGroup, Map<string, number>>();
  const incompleteWeeks = new Map<PersonalMrvMuscleGroup, Set<string>>();
  for (const muscle of observedMuscles) {
    weeklySets.set(muscle, new Map());
    incompleteWeeks.set(muscle, new Set());
  }

  for (const row of input.performanceRows) {
    const date = row.date.slice(0, 10);
    if (date < input.windowStartDate || date > input.windowEndDate) continue;
    const week = startOfUtcWeek(row.date);
    if (!week) continue;
    const muscles = movementMuscles(movementById.get(row.movementId));
    if (muscles.length === 0) {
      for (const muscle of observedMuscles) incompleteWeeks.get(muscle)?.add(week);
      continue;
    }
    if (row.sets === undefined || !Number.isFinite(row.sets) || row.sets < 0) {
      for (const muscle of muscles) incompleteWeeks.get(muscle)?.add(week);
      continue;
    }
    for (const muscle of muscles) {
      const byWeek = weeklySets.get(muscle);
      if (byWeek) byWeek.set(week, (byWeek.get(week) ?? 0) + row.sets);
    }
  }

  return [...observedMuscles]
    .sort((a, b) => a.localeCompare(b))
    .map((muscleGroup) => {
      const region = PERSONAL_MRV_REGION_BY_MUSCLE[muscleGroup];
      const strengthChanges = weeklyStrengthChanges({
        snapshots: input.strengthSnapshots,
        region,
        windowStartDate: input.windowStartDate,
        windowEndDate: input.windowEndDate,
      });
      const setsByWeek = weeklySets.get(muscleGroup) ?? new Map<string, number>();
      const excludedWeeks = incompleteWeeks.get(muscleGroup) ?? new Set<string>();
      const observations: SetStrengthObservation[] = [];
      for (const [week, strengthChange] of strengthChanges) {
        if (excludedWeeks.has(week) || incompleteProjectionWeeks.has(week)) continue;
        observations.push({ week, weeklySets: setsByWeek.get(week) ?? 0, strengthChange });
      }
      return {
        muscleGroup,
        region,
        ...estimatePersonalMrv(observations, VOLUME_LANDMARKS[muscleGroup]),
      };
    });
}
