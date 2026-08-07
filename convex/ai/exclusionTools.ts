/**
 * AI agent tools for the user's permanent exercise-exclusion list.
 *
 * This is the only durable channel the coach can write for "never program X".
 * Before it existed, the exclusions table was settings-UI-only, so a request
 * like "no jumping" had nowhere to land: the coach would hand-rebuild the
 * affected days and the algorithm would reintroduce the same movements on the
 * next program_week call. Injuries (report_injury) stay reserved for actual
 * pain and physical limitation.
 */

import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { Movement } from "../tonal/types";
import { resolveMovement } from "../tonal/movementResolve";
import { requireUserId, withToolTracking } from "./helpers";

const MAX_EXCLUSIONS_PER_CALL = 12;

const exerciseRefSchema = z.object({
  name: z
    .string()
    .optional()
    .describe(
      'Exact exercise name from search_exercises, e.g. "Frogger". Preferred — the server resolves it to a catalog ID.',
    ),
  movementId: z
    .string()
    .optional()
    .describe("UUID from search_exercises. Optional when an exact name is provided."),
});

type ExerciseRef = z.infer<typeof exerciseRefSchema>;

interface ResolvedRefs {
  readonly movementIds: string[];
  readonly unresolved: string[];
}

function resolveRefs(refs: readonly ExerciseRef[], catalog: Movement[]): ResolvedRefs {
  const movementIds: string[] = [];
  const unresolved: string[] = [];

  for (const ref of refs) {
    const outcome = resolveMovement({ movementId: ref.movementId, name: ref.name }, catalog);
    const label = ref.name ?? ref.movementId ?? "(unnamed exercise)";

    if (outcome.status === "resolved") {
      movementIds.push(outcome.movementId);
    } else if (outcome.status === "ambiguous") {
      const candidates = outcome.candidates
        .map((candidate) => `"${candidate.name}" (${candidate.movementId})`)
        .join(", ");
      unresolved.push(
        `"${label}" did not uniquely match a Tonal movement; closest: ${candidates}. Use the exact catalog name from search_exercises.`,
      );
    } else {
      unresolved.push(
        `"${label}" was not found in Tonal's catalog; call search_exercises and use an exact returned name.`,
      );
    }
  }

  return { movementIds, unresolved };
}

export const excludeExercisesTool = createTool({
  description:
    "Permanently exclude specific exercises from all future generated programming. Use when the user says never program something again, or rules out a movement pattern (no jumping, no overhead work) — call search_exercises first to find every matching movement, then exclude them all in one call. Do not use for pain or physical limitation (use report_injury), for a one-time swap in the current draft (use swap_exercise), or for equipment the user does not own. Inputs are a list of exercises identified by exact name from search_exercises; returns the excluded names and any that could not be resolved.",
  inputSchema: z.object({
    exercises: z
      .array(exerciseRefSchema)
      .min(1)
      .max(MAX_EXCLUSIONS_PER_CALL)
      .describe("Exercises to exclude. Identify each by its exact name from search_exercises."),
    reason: z
      .string()
      .optional()
      .describe("Short note on why, echoed back to the user. E.g. 'no jumping'."),
  }),
  execute: withToolTracking(
    "exclude_exercises",
    async (
      ctx,
      input,
      _options,
    ): Promise<{
      success: boolean;
      excluded: string[];
      unresolved: string[];
      message: string;
    }> => {
      const userId = requireUserId(ctx);
      const catalog: Movement[] = await ctx.runQuery(internal.tonal.movementSync.getAllMovements);
      const { movementIds, unresolved } = resolveRefs(input.exercises, catalog);

      const excluded: string[] = [];
      for (const movementId of movementIds) {
        const exclusion = await ctx.runMutation(internal.exerciseExclusions.addForUser, {
          userId: userId as Id<"users">,
          movementId,
        });
        excluded.push(exclusion.movementName);
      }

      const success = excluded.length > 0;
      const message = success
        ? `Excluded ${excluded.length} exercise(s) from future programming: ${excluded.join(", ")}. Re-run program_week to rebuild the week without them.`
        : "No exercises were excluded — none of the references resolved to a Tonal movement.";

      return { success, excluded, unresolved, message };
    },
  ),
});

export const unexcludeExercisesTool = createTool({
  description:
    "Remove exercises from the user's permanent exclusion list so programming can use them again. Use only when the user explicitly wants a previously banned movement back. Do not use to resolve an injury (use resolve_injury). Inputs are a list of exercises identified by exact name from get_exercise_exclusions or search_exercises; returns which were removed.",
  inputSchema: z.object({
    exercises: z.array(exerciseRefSchema).min(1).max(MAX_EXCLUSIONS_PER_CALL),
  }),
  execute: withToolTracking(
    "unexclude_exercises",
    async (
      ctx,
      input,
      _options,
    ): Promise<{
      success: boolean;
      removed: string[];
      unresolved: string[];
      message: string;
    }> => {
      const userId = requireUserId(ctx);
      const catalog: Movement[] = await ctx.runQuery(internal.tonal.movementSync.getAllMovements);
      const { movementIds, unresolved } = resolveRefs(input.exercises, catalog);

      const removed: string[] = [];
      for (const movementId of movementIds) {
        const result = await ctx.runMutation(internal.exerciseExclusions.removeForUser, {
          userId: userId as Id<"users">,
          movementId,
        });
        if (result.removed && result.movementName) removed.push(result.movementName);
      }

      const success = removed.length > 0;
      return {
        success,
        removed,
        unresolved,
        message: success
          ? `Removed ${removed.length} exercise(s) from the exclusion list: ${removed.join(", ")}.`
          : "Nothing was removed — those exercises were not on the exclusion list.",
      };
    },
  ),
});

export const getExerciseExclusionsTool = createTool({
  description:
    "List the exercises the user has permanently excluded from generated programming. Use before excluding more, or when the user asks what is currently banned. Do not use to list injuries (use get_injuries). Inputs are empty; returns each excluded exercise's name and muscle groups.",
  inputSchema: z.object({}),
  execute: withToolTracking(
    "get_exercise_exclusions",
    async (
      ctx,
      _input,
      _options,
    ): Promise<{ exclusions: { name: string; muscleGroups: string[] }[] }> => {
      const userId = requireUserId(ctx);
      const exclusions = await ctx.runQuery(internal.exerciseExclusions.getForUser, {
        userId: userId as Id<"users">,
      });
      return {
        exclusions: exclusions.map((exclusion) => ({
          name: exclusion.movementName,
          muscleGroups: exclusion.muscleGroups,
        })),
      };
    },
  ),
});
