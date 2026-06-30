/**
 * Rebuild a single day's workout inside an existing week plan with explicit
 * block authoring. Replaces the day's draft workoutPlan with a new one that
 * has the LLM-supplied block structure. Movement IDs are validated; rep vs
 * duration is auto-corrected against the catalog.
 *
 * If the previous day's workout was already pushed to Tonal, this action
 * does NOT auto-re-push — it leaves the new plan in `draft` status. The
 * caller (the LLM) should explicitly approve_week_plan to push.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { Movement } from "../tonal/types";
import {
  type BlockInput,
  DEFAULT_DURATION_SECONDS,
  DEFAULT_REPS,
  type ExerciseInput,
  getWellKnownMovement,
} from "../tonal/transforms";
import { resolveMovement } from "../tonal/movementResolve";
import { formatSessionTitle } from "./weekProgrammingHelpers";
import type { SessionType } from "./weekProgrammingHelpers";

const MIN_BLOCKS = 1;
const MAX_BLOCKS = 10;
const MIN_EXERCISES_PER_BLOCK = 1;
const MAX_EXERCISES_PER_BLOCK = 6;
const MIN_SETS = 1;
const MAX_SETS = 10;

const rebuildDayBlockInputValidator = v.array(
  v.object({
    exercises: v.array(
      v.object({
        name: v.optional(v.string()),
        movementId: v.optional(v.string()),
        sets: v.number(),
        reps: v.optional(v.number()),
        duration: v.optional(v.number()),
        spotter: v.optional(v.boolean()),
        eccentric: v.optional(v.boolean()),
        chains: v.optional(v.boolean()),
        burnout: v.optional(v.boolean()),
        dropSet: v.optional(v.boolean()),
        warmUp: v.optional(v.boolean()),
      }),
    ),
  }),
);

interface RebuildDayInputExercise {
  name?: string;
  movementId?: string;
  sets: number;
  reps?: number;
  duration?: number;
  spotter?: boolean;
  eccentric?: boolean;
  chains?: boolean;
  burnout?: boolean;
  dropSet?: boolean;
  warmUp?: boolean;
}

interface RebuildDayInputBlock {
  exercises: RebuildDayInputExercise[];
}

type ResolveRebuildDayBlocksResult =
  { ok: true; blocks: BlockInput[] } | { ok: false; error: string };

export const rebuildDay = internalAction({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    dayIndex: v.number(),
    title: v.optional(v.string()),
    blocks: rebuildDayBlockInputValidator,
  },
  handler: async (
    ctx,
    { userId, weekPlanId, dayIndex, title, blocks },
  ): Promise<{ ok: true; workoutPlanId: Id<"workoutPlans"> } | { ok: false; error: string }> => {
    if (dayIndex < 0 || dayIndex > 6) {
      throw new Error("dayIndex must be 0 (Monday) through 6 (Sunday)");
    }

    const plan = await ctx.runQuery(internal.weekPlans.getWeekPlanById, {
      weekPlanId,
      userId,
    });
    if (!plan) throw new Error("Week plan not found or access denied");

    const day = plan.days[dayIndex];
    if (!day) throw new Error("Invalid day index");
    if (day.sessionType === "rest" || day.sessionType === "recovery") {
      return { ok: false, error: "Cannot rebuild a rest or recovery day" };
    }

    const validationError = validateRebuildDayBlocks(blocks);
    if (validationError) return { ok: false, error: validationError };

    const catalog: Movement[] = await ctx.runQuery(internal.tonal.movementSync.getAllMovements);
    const resolved = resolveRebuildDayBlocks(blocks, catalog);
    if (!resolved.ok) return { ok: false, error: resolved.error };

    const sessionType = day.sessionType as SessionType;
    const finalTitle = title ?? formatSessionTitle(sessionType, plan.weekStartDate, dayIndex);
    const oldWorkoutPlanId = day.workoutPlanId;

    const newPlanId = (await ctx.runMutation(internal.weekPlans.createDraftWorkoutInternal, {
      userId,
      title: finalTitle,
      blocks: resolved.blocks,
      estimatedDuration: day.estimatedDuration,
    })) as Id<"workoutPlans">;

    await ctx.runMutation(internal.weekPlans.linkWorkoutPlanToDayInternal, {
      userId,
      weekPlanId,
      dayIndex,
      workoutPlanId: newPlanId,
      estimatedDuration: day.estimatedDuration,
    });

    if (oldWorkoutPlanId) {
      await ctx.runMutation(internal.weekPlans.deleteDraftWorkout, {
        workoutPlanId: oldWorkoutPlanId,
      });
    }

    return { ok: true, workoutPlanId: newPlanId };
  },
});

function validateRebuildDayBlocks(blocks: RebuildDayInputBlock[]): string | null {
  if (blocks.length < MIN_BLOCKS || blocks.length > MAX_BLOCKS) {
    return `blocks must contain between ${MIN_BLOCKS} and ${MAX_BLOCKS} items`;
  }

  for (const [blockIndex, block] of blocks.entries()) {
    const exerciseCount = block.exercises.length;
    if (exerciseCount < MIN_EXERCISES_PER_BLOCK || exerciseCount > MAX_EXERCISES_PER_BLOCK) {
      return `blocks[${blockIndex}].exercises must contain between ${MIN_EXERCISES_PER_BLOCK} and ${MAX_EXERCISES_PER_BLOCK} items`;
    }

    for (const [exerciseIndex, exercise] of block.exercises.entries()) {
      const prefix = `blocks[${blockIndex}].exercises[${exerciseIndex}]`;
      if (
        !Number.isInteger(exercise.sets) ||
        exercise.sets < MIN_SETS ||
        exercise.sets > MAX_SETS
      ) {
        return `${prefix}.sets must be an integer between ${MIN_SETS} and ${MAX_SETS}`;
      }
      if (exercise.reps !== undefined && (!Number.isInteger(exercise.reps) || exercise.reps <= 0)) {
        return `${prefix}.reps must be a positive integer`;
      }
      if (
        exercise.duration !== undefined &&
        (!Number.isInteger(exercise.duration) || exercise.duration <= 0)
      ) {
        return `${prefix}.duration must be a positive integer`;
      }
    }
  }

  return null;
}

function resolveRebuildDayBlocks(
  blocks: RebuildDayInputBlock[],
  catalog: Movement[],
): ResolveRebuildDayBlocksResult {
  const movementMap = new Map(catalog.map((movement) => [movement.id, movement]));
  const resolvedBlocks: BlockInput[] = [];
  const unresolved: string[] = [];

  for (const block of blocks) {
    const exercises: ExerciseInput[] = [];
    for (const exercise of block.exercises) {
      const outcome = resolveMovement(
        { movementId: exercise.movementId, name: exercise.name },
        catalog,
      );
      if (outcome.status === "resolved") {
        exercises.push(correctExercise(exercise, outcome.movementId, movementMap));
        continue;
      }

      const label = exercise.name ?? exercise.movementId ?? "(unnamed exercise)";
      if (outcome.status === "ambiguous") {
        const candidates = outcome.candidates
          .map((candidate) => `"${candidate.name}" (${candidate.movementId})`)
          .join(", ");
        unresolved.push(
          `"${label}" did not uniquely match a Tonal movement; closest: ${candidates}. Set "name" to the exact catalog name from search_exercises.`,
        );
      } else {
        unresolved.push(
          `"${label}" was not found in Tonal's catalog; call search_exercises and use an exact returned name.`,
        );
      }
    }
    resolvedBlocks.push({ exercises });
  }

  if (unresolved.length > 0) {
    const totalExercises = blocks.reduce((total, block) => total + block.exercises.length, 0);
    return {
      ok: false,
      error: `Could not resolve ${unresolved.length} of ${totalExercises} exercises to Tonal movements:\n- ${unresolved.join("\n- ")}`,
    };
  }

  return { ok: true, blocks: resolvedBlocks };
}

function correctExercise(
  exercise: RebuildDayInputExercise,
  movementId: string,
  movementMap: Map<string, Movement>,
): ExerciseInput {
  const { name: _name, movementId: _inputMovementId, ...rest } = exercise;
  const movement = movementMap.get(movementId) ?? getWellKnownMovement(movementId);

  if (movement && !movement.countReps) {
    return {
      ...rest,
      movementId,
      duration: exercise.duration ?? DEFAULT_DURATION_SECONDS,
      reps: undefined,
    };
  }

  return {
    ...rest,
    movementId,
    reps: exercise.reps ?? DEFAULT_REPS,
    duration: undefined,
  };
}
