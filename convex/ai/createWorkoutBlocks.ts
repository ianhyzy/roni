import type { Movement } from "../tonal/types";
import { DEFAULT_DURATION_SECONDS, DEFAULT_REPS, getWellKnownMovement } from "../tonal/transforms";
import { resolveMovement } from "../tonal/movementResolve";

export interface WorkoutInputExercise {
  name?: string;
  movementId?: string;
  sets: number;
  reps?: number;
  duration?: number;
  spotter: boolean;
  eccentric: boolean;
  warmUp: boolean;
}

export interface WorkoutInputBlock {
  exercises: WorkoutInputExercise[];
}

interface ResolvedExercise {
  movementId: string;
  sets: number;
  reps?: number;
  duration?: number;
  spotter: boolean;
  eccentric: boolean;
  warmUp: boolean;
}

interface ResolvedBlock {
  exercises: ResolvedExercise[];
}

export type ResolveWorkoutBlocksResult =
  | { ok: true; blocks: ResolvedBlock[] }
  | { ok: false; error: string };

/**
 * Resolve every exercise in the coach's create_workout blocks to a real Tonal
 * catalog ID by name (repairing missing or wrong movementIds), then auto-correct
 * reps vs duration. Returns a structured error listing the exercises that could
 * not be resolved so the model can re-issue with exact names from search_exercises.
 */
export function resolveWorkoutBlocks(
  blocks: WorkoutInputBlock[],
  catalog: Movement[],
): ResolveWorkoutBlocksResult {
  const movementMap = new Map(catalog.map((m) => [m.id, m]));
  const resolvedBlocks: ResolvedBlock[] = [];
  const unresolved: string[] = [];

  for (const block of blocks) {
    const exercises: ResolvedExercise[] = [];
    for (const ex of block.exercises) {
      const outcome = resolveMovement({ movementId: ex.movementId, name: ex.name }, catalog);
      if (outcome.status === "resolved") {
        const { name: _name, ...rest } = ex;
        exercises.push(
          correctRepsAndDuration({ ...rest, movementId: outcome.movementId }, movementMap),
        );
        continue;
      }
      const label = ex.name ?? ex.movementId ?? "(unnamed exercise)";
      if (outcome.status === "ambiguous") {
        const opts = outcome.candidates.map((c) => `"${c.name}"`).join(", ");
        unresolved.push(
          `"${label}" did not uniquely match a Tonal movement; closest: ${opts}. Set "name" to the exact catalog name.`,
        );
      } else {
        unresolved.push(
          `"${label}" was not found in Tonal's catalog; call search_exercises and use a name it returns.`,
        );
      }
    }
    resolvedBlocks.push({ exercises });
  }

  if (unresolved.length > 0) {
    const total = blocks.reduce((n, b) => n + b.exercises.length, 0);
    return {
      ok: false,
      error: `Could not resolve ${unresolved.length} of ${total} exercises to Tonal movements:\n- ${unresolved.join("\n- ")}`,
    };
  }

  return { ok: true, blocks: resolvedBlocks };
}

/** Use duration for duration-based movements and reps for rep-based ones. */
function correctRepsAndDuration(
  ex: ResolvedExercise,
  movementMap: Map<string, Movement>,
): ResolvedExercise {
  const movement = movementMap.get(ex.movementId) ?? getWellKnownMovement(ex.movementId);
  if (movement && !movement.countReps) {
    return { ...ex, duration: ex.duration ?? DEFAULT_DURATION_SECONDS, reps: undefined };
  }
  return { ...ex, reps: ex.reps ?? DEFAULT_REPS, duration: undefined };
}
