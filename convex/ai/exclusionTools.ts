/**
 * AI agent tools for the user's permanent exercise-exclusion list.
 *
 * This is the only durable channel the coach can write for "never program X".
 * Before it existed, the exclusions table was settings-UI-only, so a request
 * like "no jumping" had nowhere to land: the coach would hand-rebuild the
 * affected days instead of explicitly excluding matching catalog entries.
 * Injuries (report_injury) stay reserved for actual pain and physical
 * limitation.
 */

import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { MAX_EXCLUSION_BATCH_SIZE } from "../exerciseExclusions";
import type { Movement } from "../tonal/types";
import { resolveMovement } from "../tonal/movementResolve";
import { requireUserId, withToolTracking } from "./helpers";

const exerciseRefSchema = z
  .object({
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
  })
  .refine(({ name, movementId }) => Boolean(name?.trim() || movementId?.trim()), {
    message: "Exercise reference requires a non-empty name or movementId.",
  });

type ExerciseRef = z.infer<typeof exerciseRefSchema>;

interface ResolvedRefs {
  readonly movementIds: string[];
  readonly unresolved: string[];
}

function resolveRefs(refs: readonly ExerciseRef[], catalog: Movement[]): ResolvedRefs {
  const movementIds: string[] = [];
  const unresolved: string[] = [];
  const catalogMovementIds = new Set(catalog.map((movement) => movement.id));

  for (const ref of refs) {
    const movementId = ref.movementId?.trim() || undefined;
    const name = ref.name?.trim() || undefined;
    const outcome = resolveMovement({ movementId, name }, catalog);
    const label = name ?? movementId ?? "(unnamed exercise)";

    if (outcome.status === "resolved" && catalogMovementIds.has(outcome.movementId)) {
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
    "Permanently exclude exact current Tonal catalog entries from generated programming. Use when the user wants one or more specific current exercises permanently excluded. Call search_exercises first. Inputs are exact returned names or movement IDs, with at most 12 entries per call. A request about a broad category must be translated into explicit current catalog entries; these exclusions do not automatically cover future catalog additions. Do not use for pain or physical limitation (use report_injury), for a one-time swap in the current draft (use swap_exercise), or for equipment the user does not own. Returns the excluded names and any references that could not be resolved.",
  inputSchema: z.object({
    exercises: z
      .array(exerciseRefSchema)
      .min(1)
      .max(MAX_EXCLUSION_BATCH_SIZE)
      .describe("Exercises to exclude. Identify each by its exact name from search_exercises."),
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

      const exclusions =
        movementIds.length > 0
          ? await ctx.runMutation(internal.exerciseExclusions.addManyForUser, {
              userId: userId as Id<"users">,
              movementIds,
            })
          : [];
      const excluded = exclusions.map((exclusion) => exclusion.movementName);

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
    "Remove exact exercises from the user's permanent exclusion list so programming can use them again. Use only when the user explicitly wants a previously banned movement back. Call get_exercise_exclusions first. Inputs are its stable movementId values. Do not use to resolve an injury (use resolve_injury). Returns which exclusions were removed.",
  inputSchema: z.object({
    movementIds: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(MAX_EXCLUSION_BATCH_SIZE)
      .describe("movementId values returned by get_exercise_exclusions."),
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
      message: string;
    }> => {
      const userId = requireUserId(ctx);
      const removals = await ctx.runMutation(internal.exerciseExclusions.removeManyForUser, {
        userId: userId as Id<"users">,
        movementIds: input.movementIds,
      });
      const removed = removals.map((exclusion) => exclusion.movementName);

      const success = removed.length > 0;
      return {
        success,
        removed,
        message: success
          ? `Removed ${removed.length} exercise(s) from the exclusion list: ${removed.join(", ")}.`
          : "Nothing was removed — those exercises were not on the exclusion list.",
      };
    },
  ),
});

export const getExerciseExclusionsTool = createTool({
  description:
    "List the exact exercises the user has permanently excluded from generated programming. Use before excluding more, before unexcluding, or when the user asks what is currently banned. Do not use to list injuries (use get_injuries). Inputs are empty; returns each excluded exercise's stable movementId, name, and muscle groups.",
  inputSchema: z.object({}),
  execute: withToolTracking(
    "get_exercise_exclusions",
    async (
      ctx,
      _input,
      _options,
    ): Promise<{
      exclusions: { movementId: string; name: string; muscleGroups: string[] }[];
    }> => {
      const userId = requireUserId(ctx);
      const exclusions = await ctx.runQuery(internal.exerciseExclusions.getForUser, {
        userId: userId as Id<"users">,
      });
      return {
        exclusions: exclusions.map((exclusion) => ({
          movementId: exclusion.movementId,
          name: exclusion.movementName,
          muscleGroups: exclusion.muscleGroups,
        })),
      };
    },
  ),
});
