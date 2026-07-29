import type { TrackedMuscleGroup } from "./volumeLandmarks";

export const MIN_MRV_HALF_OBSERVATIONS = 12;
export const MIN_MRV_SEGMENT_OBSERVATIONS = 4;
export const MIN_MRV_CLIFFS_DELTA = 0.33;

export type PersonalMrvMuscleGroup = TrackedMuscleGroup;
export type PersonalMrvRegion = "upper" | "lower";

export const PERSONAL_MRV_REGION_BY_MUSCLE: Readonly<
  Record<PersonalMrvMuscleGroup, PersonalMrvRegion>
> = {
  Chest: "upper",
  Back: "upper",
  Shoulders: "upper",
  Biceps: "upper",
  Triceps: "upper",
  Quads: "lower",
  Glutes: "lower",
  Hamstrings: "lower",
  Calves: "lower",
};

const MUSCLE_ALIASES: Readonly<Record<string, PersonalMrvMuscleGroup>> = {
  chest: "Chest",
  back: "Back",
  shoulders: "Shoulders",
  shoulder: "Shoulders",
  biceps: "Biceps",
  bicep: "Biceps",
  triceps: "Triceps",
  tricep: "Triceps",
  quads: "Quads",
  quadriceps: "Quads",
  glutes: "Glutes",
  glute: "Glutes",
  hamstrings: "Hamstrings",
  hamstring: "Hamstrings",
  calves: "Calves",
  calf: "Calves",
};

export interface SetStrengthObservation {
  week: string;
  weeklySets: number;
  strengthChange: number;
}

export interface PersonalMrvThresholdEvidence {
  capWeeklySets: number;
  atOrBelowCount: number;
  aboveCount: number;
  atOrBelowMedianStrengthChange: number;
  aboveMedianStrengthChange: number;
  cliffsDelta: number;
}

export type PersonalMrvEstimate =
  | {
      status: "insufficient_data";
      pairedObservationCount: number;
      reason: "not_enough_non_overlapping_history";
    }
  | {
      status: "advisory_only";
      pairedObservationCount: number;
      reason:
        | "no_training_threshold"
        | "no_validation_threshold"
        | "unstable_threshold"
        | "threshold_below_literature_minimum";
      training?: PersonalMrvThresholdEvidence;
      validation?: PersonalMrvThresholdEvidence;
    }
  | {
      status: "qualified_for_enforcement";
      pairedObservationCount: number;
      maxWeeklySets: number;
      literatureMinWeeklySets: number;
      literatureMaxWeeklySets: number;
      training: PersonalMrvThresholdEvidence;
      validation: PersonalMrvThresholdEvidence;
    };

interface FittedThreshold extends PersonalMrvThresholdEvidence {
  absoluteDeviation: number;
}

export function canonicalPersonalMrvMuscleGroup(
  muscleGroup: string,
): PersonalMrvMuscleGroup | null {
  return MUSCLE_ALIASES[muscleGroup.trim().toLowerCase()] ?? null;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function cliffsDelta(atOrBelow: readonly number[], above: readonly number[]): number {
  let favorable = 0;
  let unfavorable = 0;
  for (const lowerVolumeChange of atOrBelow) {
    for (const higherVolumeChange of above) {
      if (lowerVolumeChange > higherVolumeChange) favorable += 1;
      if (lowerVolumeChange < higherVolumeChange) unfavorable += 1;
    }
  }
  return (favorable - unfavorable) / (atOrBelow.length * above.length);
}

function fitThreshold(observations: readonly SetStrengthObservation[]): FittedThreshold | null {
  const candidateCaps = [
    ...new Set(observations.map((observation) => observation.weeklySets)),
  ].sort((a, b) => a - b);
  let best: FittedThreshold | null = null;

  for (const capWeeklySets of candidateCaps) {
    const atOrBelow = observations.filter((observation) => observation.weeklySets <= capWeeklySets);
    const above = observations.filter((observation) => observation.weeklySets > capWeeklySets);
    if (
      atOrBelow.length < MIN_MRV_SEGMENT_OBSERVATIONS ||
      above.length < MIN_MRV_SEGMENT_OBSERVATIONS
    ) {
      continue;
    }

    const atOrBelowChanges = atOrBelow.map((observation) => observation.strengthChange);
    const aboveChanges = above.map((observation) => observation.strengthChange);
    const atOrBelowMedianStrengthChange = median(atOrBelowChanges);
    const aboveMedianStrengthChange = median(aboveChanges);
    const effect = cliffsDelta(atOrBelowChanges, aboveChanges);
    if (
      atOrBelowMedianStrengthChange < 0 ||
      aboveMedianStrengthChange >= 0 ||
      effect < MIN_MRV_CLIFFS_DELTA
    ) {
      continue;
    }

    const absoluteDeviation =
      atOrBelowChanges.reduce(
        (total, value) => total + Math.abs(value - atOrBelowMedianStrengthChange),
        0,
      ) +
      aboveChanges.reduce((total, value) => total + Math.abs(value - aboveMedianStrengthChange), 0);
    const fitted: FittedThreshold = {
      capWeeklySets,
      atOrBelowCount: atOrBelow.length,
      aboveCount: above.length,
      atOrBelowMedianStrengthChange,
      aboveMedianStrengthChange,
      cliffsDelta: Math.round(effect * 1_000) / 1_000,
      absoluteDeviation,
    };
    if (
      best === null ||
      fitted.absoluteDeviation < best.absoluteDeviation ||
      (fitted.absoluteDeviation === best.absoluteDeviation &&
        fitted.capWeeklySets < best.capWeeklySets)
    ) {
      best = fitted;
    }
  }

  return best;
}

function publicEvidence(fitted: FittedThreshold): PersonalMrvThresholdEvidence {
  const { absoluteDeviation: _absoluteDeviation, ...evidence } = fitted;
  return evidence;
}

export function estimatePersonalMrv(
  observations: readonly SetStrengthObservation[],
  literatureRange: { min: number; max: number },
): PersonalMrvEstimate {
  const valid = observations
    .filter(
      (observation) =>
        Number.isFinite(observation.weeklySets) &&
        observation.weeklySets >= 0 &&
        Number.isFinite(observation.strengthChange),
    )
    .sort((a, b) => a.week.localeCompare(b.week));
  const midpoint = Math.floor(valid.length / 2);
  const trainingRows = valid.slice(0, midpoint);
  const validationRows = valid.slice(midpoint);
  if (
    trainingRows.length < MIN_MRV_HALF_OBSERVATIONS ||
    validationRows.length < MIN_MRV_HALF_OBSERVATIONS
  ) {
    return {
      status: "insufficient_data",
      pairedObservationCount: valid.length,
      reason: "not_enough_non_overlapping_history",
    };
  }

  const training = fitThreshold(trainingRows);
  if (!training) {
    return {
      status: "advisory_only",
      pairedObservationCount: valid.length,
      reason: "no_training_threshold",
    };
  }
  const validation = fitThreshold(validationRows);
  if (!validation) {
    return {
      status: "advisory_only",
      pairedObservationCount: valid.length,
      reason: "no_validation_threshold",
      training: publicEvidence(training),
    };
  }

  const agreementTolerance = Math.max(
    2,
    Math.min(training.capWeeklySets, validation.capWeeklySets) * 0.2,
  );
  if (Math.abs(training.capWeeklySets - validation.capWeeklySets) > agreementTolerance) {
    return {
      status: "advisory_only",
      pairedObservationCount: valid.length,
      reason: "unstable_threshold",
      training: publicEvidence(training),
      validation: publicEvidence(validation),
    };
  }
  if (Math.min(training.capWeeklySets, validation.capWeeklySets) < literatureRange.min) {
    return {
      status: "advisory_only",
      pairedObservationCount: valid.length,
      reason: "threshold_below_literature_minimum",
      training: publicEvidence(training),
      validation: publicEvidence(validation),
    };
  }

  return {
    status: "qualified_for_enforcement",
    pairedObservationCount: valid.length,
    maxWeeklySets: Math.floor(
      Math.min(training.capWeeklySets, validation.capWeeklySets, literatureRange.max),
    ),
    literatureMinWeeklySets: literatureRange.min,
    literatureMaxWeeklySets: literatureRange.max,
    training: publicEvidence(training),
    validation: publicEvidence(validation),
  };
}
