import type { WorkoutSetInput } from "./types";

/** Well-known Tonal movement ID for rest periods between sets. */
export const TONAL_REST_MOVEMENT_ID = "00000000-0000-0000-0000-000000000005";

export interface ExerciseInput {
  movementId: string;
  sets: number;
  reps?: number;
  duration?: number;
  warmUp?: boolean;
  spotter?: boolean;
  eccentric?: boolean;
  chains?: boolean;
  burnout?: boolean;
  dropSet?: boolean;
}

export interface BlockInput {
  exercises: ExerciseInput[];
}

/** Optional movement catalog for auto-correcting duration vs reps and alternating rep counts. */
export interface MovementCatalogEntry {
  id: string;
  countReps: boolean;
  isAlternating: boolean;
  muscleGroups?: string[];
}

/**
 * Synthetic Tonal movements that are valid in workout payloads but are NOT
 * returned by Tonal's `/v6/movements` catalog, so they never land in the
 * `movements` table. Catalog-membership validation must treat these as valid;
 * otherwise the coach can never push a workout that injects them (e.g. the
 * Rest period added to every single-exercise block). All entries are
 * duration-based — they have no rep count.
 */
export const WELL_KNOWN_MOVEMENTS: readonly MovementCatalogEntry[] = [
  { id: TONAL_REST_MOVEMENT_ID, countReps: false, isAlternating: false },
];

const WELL_KNOWN_MOVEMENT_MAP: ReadonlyMap<string, MovementCatalogEntry> = new Map(
  WELL_KNOWN_MOVEMENTS.map((m) => [m.id, m]),
);

/** True when the id is a synthetic, catalog-exempt movement such as Rest. */
export function isWellKnownMovementId(id: string): boolean {
  return WELL_KNOWN_MOVEMENT_MAP.has(id);
}

/** Catalog entry for a well-known synthetic movement, or undefined if not one. */
export function getWellKnownMovement(id: string): MovementCatalogEntry | undefined {
  return WELL_KNOWN_MOVEMENT_MAP.get(id);
}

interface BuildSetOpts {
  ex: ExerciseInput;
  blockNumber: number;
  exIdx: number;
  round: number;
  isFirstInBlock: boolean;
  /** If provided, auto-corrects duration vs reps based on countReps. */
  movementMap?: Map<string, MovementCatalogEntry>;
}

const DEFAULT_DURATION_SECONDS = 30;
const DEFAULT_REPS = 10;

/**
 * Tonal rejects an explicit 0 or negative prescribedReps/prescribedDuration with
 * HTTP 400 ("prescribed reps or duration zero (not nil) or negative"); a nil value
 * is accepted. `value ?? fallback` would preserve 0, so non-positive or non-finite
 * inputs are treated as unspecified and fall back to the default. (#447)
 */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function buildSet({
  ex,
  blockNumber,
  exIdx,
  round,
  isFirstInBlock,
  movementMap,
}: BuildSetOpts): WorkoutSetInput {
  const set: WorkoutSetInput = {
    blockStart: isFirstInBlock,
    movementId: ex.movementId,
    blockNumber,
    setGroup: exIdx + 1,
    round,
    repetition: round,
    repetitionTotal: ex.sets,
    burnout: ex.burnout ?? false,
    spotter: ex.spotter ?? false,
    eccentric: ex.eccentric ?? false,
    chains: ex.chains ?? false,
    flex: false,
    warmUp: ex.warmUp ?? false,
    dropSet: ex.dropSet ?? false,
    weightPercentage: 100,
    description: "",
  };

  // Auto-correct based on movement catalog if available
  const movement = movementMap?.get(ex.movementId);
  const isDurationBased = movement ? !movement.countReps : false;
  // Only a positive duration counts as caller-provided; a 0/negative value must not
  // route a rep-based movement into an invalid duration set.
  const hasExplicitDuration = typeof ex.duration === "number" && ex.duration > 0;

  if (isDurationBased || hasExplicitDuration) {
    set.prescribedDuration = positiveOr(ex.duration, DEFAULT_DURATION_SECONDS);
    set.prescribedResistanceLevel = 5;
  } else {
    const baseReps = positiveOr(ex.reps, DEFAULT_REPS);
    // Tonal counts total reps for alternating exercises (5 per side = 10 total).
    // AI prescribes per-side reps, so double for alternating movements.
    const isAlternating = movement?.isAlternating ?? false;
    set.prescribedReps = isAlternating ? baseReps * 2 : baseReps;
  }

  return set;
}

function expandBlock(
  block: BlockInput,
  blockNumber: number,
  startIdx: number,
  movementMap?: Map<string, MovementCatalogEntry>,
): WorkoutSetInput[] {
  const sets: WorkoutSetInput[] = [];
  const maxRounds = Math.max(...block.exercises.map((e) => e.sets));

  for (let round = 1; round <= maxRounds; round++) {
    for (let exIdx = 0; exIdx < block.exercises.length; exIdx++) {
      const ex = block.exercises[exIdx];
      if (round > ex.sets) continue;
      sets.push(
        buildSet({
          ex,
          blockNumber,
          exIdx,
          round,
          isFirstInBlock: startIdx + sets.length === 0,
          movementMap,
        }),
      );
    }
  }

  // Mark first set of this block
  if (sets.length > 0) sets[0] = { ...sets[0], blockStart: true };
  return sets;
}

/**
 * Expand block inputs into flat workout sets for the Tonal API.
 * If a movement catalog is provided, auto-corrects duration vs reps based on countReps.
 */
export function expandBlocksToSets(
  blocks: BlockInput[],
  catalog?: MovementCatalogEntry[],
): WorkoutSetInput[] {
  const movementMap = catalog ? new Map(catalog.map((m) => [m.id, m])) : undefined;
  return blocks.flatMap((block, blockIdx) =>
    expandBlock(block, blockIdx + 1, blockIdx, movementMap),
  );
}

export function buildTonalWorkoutSets(
  blocks: BlockInput[],
  catalog: MovementCatalogEntry[],
): WorkoutSetInput[] {
  const filteredSets = expandBlocksToSets(blocks, catalog).filter(
    (set) => !isWellKnownMovementId(set.movementId),
  );
  const seenBlockNumbers = new Set<number>();
  return filteredSets.map((set) => {
    const blockStart = !seenBlockNumbers.has(set.blockNumber);
    seenBlockNumbers.add(set.blockNumber);
    return set.blockStart === blockStart ? set : { ...set, blockStart };
  });
}
