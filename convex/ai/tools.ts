import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import type {
  Activity,
  Movement,
  MuscleReadiness,
  StrengthScore,
  StrengthScoreHistoryEntry,
} from "../tonal/types";
import type { EnrichedWorkoutDetail } from "../workoutDetail";
import { resolveWorkoutBlocks } from "./createWorkoutBlocks";
import { requireUserId, withToolTracking } from "./helpers";

export const KNOWN_TRAINING_TYPES = [
  "Strength",
  "High Intensity",
  "Mobility",
  "Recovery",
  "Yoga",
  "Pilates",
  "Pre & Postnatal",
] as const;

export const searchExercisesTool = createTool({
  description:
    "Search Tonal's exercise catalog by name, muscle group, and/or training type. Use when the coach needs canonical Tonal exercise names, movement IDs, accessory requirements, or whether a movement uses reps versus duration. Do not use for the user's completed workout history, performance trends, or plan details. Inputs can search by name, muscle group, training type, and optional loose description matching; returns matching catalog rows with movementId, name, muscleGroups, accessory, trainingTypes, and isDurationBased.",
  inputSchema: z.object({
    name: z
      .string()
      .optional()
      .describe(
        "Exercise name or common name (e.g. 'Romanian Deadlift', 'RDL'). Match is on name and shortName by default — descriptions are not searched.",
      ),
    muscleGroup: z
      .string()
      .optional()
      .describe("Use when exploring options for a body part, e.g. Chest, Back, Quads, Shoulders."),
    trainingType: z
      .enum(KNOWN_TRAINING_TYPES)
      .optional()
      .describe(
        `Use to narrow by type. Valid values: ${KNOWN_TRAINING_TYPES.join(", ")}. Note: there is NO 'Warm-up' tag — Tonal warmups are tagged 'Mobility'.`,
      ),
    looseMatch: z
      .boolean()
      .optional()
      .describe(
        "When true, fall back to matching in exercise descriptions in addition to name/shortName. Use only if a strict search returns no results. Default: false (strict, name-only).",
      ),
  }),
  execute: withToolTracking("search_exercises", async (ctx, input, _options) => {
    const results = (await ctx.runQuery(internal.tonal.movementSearchQueries.searchMovements, {
      name: input.name,
      muscleGroup: input.muscleGroup,
      trainingType: input.trainingType,
      limit: 30,
      matchMode: input.looseMatch ? "loose" : "strict",
    })) as Movement[];

    return results.map((m) => ({
      movementId: m.id,
      name: m.name,
      muscleGroups: m.muscleGroups,
      onMachine: m.onMachine,
      skillLevel: m.skillLevel,
      accessory: m.onMachineInfo?.accessory ?? "None",
      trainingTypes: m.trainingTypes ?? [],
      isDurationBased: !m.countReps,
    }));
  }),
});

export const getStrengthScoresTool = createTool({
  description:
    "Get Tonal Strength Scores by body region. Use when the user asks about Tonal's proprietary strength score, body-region strength, overall score, or percentile. Do not use these values as lifted weight in pounds; use workout history or workout detail for actual load data. Inputs are empty; returns regional 0-999 scores, overall score, percentile, and a warning note about the metric.",
  inputSchema: z.object({}),
  execute: withToolTracking(
    "get_strength_scores",
    async (
      ctx,
      _input,
      _options,
    ): Promise<{
      note: string;
      scores: { region: string; score: number }[];
      overall: number;
      percentile: number;
    }> => {
      const userId = requireUserId(ctx);
      const scores = (await ctx.runAction(internal.tonal.proxy.fetchStrengthScores, {
        userId,
      })) as StrengthScore[];

      const distribution = (await ctx.runAction(internal.tonal.proxy.fetchStrengthDistribution, {
        userId,
      })) as { overallScore: number; percentile: number };

      return {
        note: "Tonal Strength Scores are a proprietary metric (0-999 scale), NOT weight in pounds. Do not report these as lbs.",
        scores: scores.map((s) => ({
          region: s.bodyRegionDisplay,
          score: s.score,
        })),
        overall: distribution.overallScore,
        percentile: distribution.percentile,
      };
    },
  ),
});

export const getStrengthHistoryTool = createTool({
  description:
    "Get Tonal Strength Score history over time by region. Use when the user asks whether their proprietary strength scores are rising or falling across recent entries. Do not use for exercise-level weights, reps, PRs, plateaus, or completed workout lists. Inputs are empty; returns up to 30 recent strength-score history entries per region.",
  inputSchema: z.object({}),
  execute: withToolTracking(
    "get_strength_history",
    async (ctx, _input, _options): Promise<StrengthScoreHistoryEntry[]> => {
      const userId = requireUserId(ctx);
      const history = (await ctx.runAction(internal.tonal.proxyProjected.fetchStrengthHistory, {
        userId,
      })) as StrengthScoreHistoryEntry[];
      // Cap returned entries to prevent large tool results from bloating context
      return history.slice(0, 30);
    },
  ),
});

export const getMuscleReadinessTool = createTool({
  description:
    "Get Tonal muscle readiness on a 0-100 scale per muscle group. Use when deciding whether to train, avoid, or reduce volume for fatigued muscles. Do not use as a completed-workout volume report or a substitute for injury restrictions. Inputs are empty; returns current readiness values keyed by muscle group.",
  inputSchema: z.object({}),
  execute: withToolTracking(
    "get_muscle_readiness",
    async (ctx, _input, _options): Promise<MuscleReadiness> => {
      const userId = requireUserId(ctx);
      return (await ctx.runAction(internal.tonal.proxy.fetchMuscleReadiness, {
        userId,
      })) as MuscleReadiness;
    },
  ),
});

export const getWorkoutHistoryTool = createTool({
  description:
    "List a window of recent completed Tonal workouts. Use when the user asks what they have done recently or when another tool needs an activityId for a specific completed workout. Do not use for exercise names, per-set details, PRs, plateaus, or multi-workout trend analysis. Input is an optional limit; returns one row per workout with activityId, date, title, targetArea, totalVolume, duration, and type.",
  inputSchema: z.object({
    limit: z.number().optional().default(20).describe("Max workouts to return"),
  }),
  execute: withToolTracking("get_workout_history", async (ctx, input, _options) => {
    const userId = requireUserId(ctx);
    const activities = (await ctx.runAction(
      internal.tonal.workoutHistoryProxy.fetchWorkoutHistory,
      {
        userId,
        limit: input.limit,
      },
    )) as Activity[];

    return activities.map((a) => ({
      activityId: a.activityId,
      date: a.activityTime,
      title: a.workoutPreview.workoutTitle,
      targetArea: a.workoutPreview.targetArea,
      totalVolume: a.workoutPreview.totalVolume,
      duration: a.workoutPreview.totalDuration,
      type: a.workoutPreview.workoutType,
    }));
  }),
});

export const getWorkoutDetailTool = createTool({
  description:
    "Retrieve full details for one completed Tonal workout by activityId. Use when the user asks which exercises, sets, reps, durations, weights, or PR flags appeared in a specific workout. Do not use for listing many workouts or comparing progress across workouts; use get_workout_history or get_workout_performance for those. Input is activityId from get_workout_history; returns resolved exercise names, muscle groups, per-set data, and per-movement summaries.",
  inputSchema: z.object({
    activityId: z.string().describe("Activity ID from workout history"),
  }),
  execute: withToolTracking(
    "get_workout_detail",
    async (ctx, input, _options): Promise<EnrichedWorkoutDetail | null> => {
      // Call the internal action with explicit userId. Calling the public
      // action via `api.workoutDetail.getWorkoutDetail` from the agent runtime
      // failed ~46% of the time with "Not authenticated" — the agent runtime
      // doesn't reliably propagate auth context through runAction.
      const userId = requireUserId(ctx);
      return (await ctx.runAction(internal.workoutDetail.getWorkoutDetailInternal, {
        userId,
        activityId: input.activityId,
      })) as EnrichedWorkoutDetail | null;
    },
  ),
});

export const getTrainingFrequencyTool = createTool({
  description:
    "Summarize recent training frequency by target area or muscle group. Use when the user asks how often they have trained areas like legs, chest, back, or shoulders in the recent history window. Do not use for set-volume recommendations, muscle readiness, or exercise-level performance. Inputs are empty; returns sessionsPerArea, lastTrainedPerArea, totalSessions, and periodDays.",
  inputSchema: z.object({}),
  execute: withToolTracking("get_training_frequency", async (ctx, _input, _options) => {
    const userId = requireUserId(ctx);
    const activities = (await ctx.runAction(
      internal.tonal.workoutHistoryProxy.fetchWorkoutHistory,
      {
        userId,
        limit: 30,
      },
    )) as Activity[];

    const muscleGroupCounts: Record<string, number> = {};
    const lastTrained: Record<string, string> = {};

    for (const a of activities) {
      const area = a.workoutPreview.targetArea;
      if (area) {
        muscleGroupCounts[area] = (muscleGroupCounts[area] || 0) + 1;
        if (!lastTrained[area]) {
          lastTrained[area] = a.activityTime;
        }
      }
    }

    return {
      sessionsPerArea: muscleGroupCounts,
      lastTrainedPerArea: lastTrained,
      totalSessions: activities.length,
      periodDays: 30,
    };
  }),
});

export const createWorkoutTool = createTool({
  description:
    "Create one standalone custom workout on Tonal outside the weekly plan. Use when the user asks for a single one-off workout to push directly to Tonal. Do not use for weekly programming, draft week edits, or multiple scheduled sessions; use program_week, rebuild_day, or the draft modification tools for those. Inputs require a title and blocks of exercises; give each exercise its `name` from search_exercises (the server resolves the real Tonal ID, repairing a missing or wrong movementId) plus reps for rep-based movements or duration seconds for duration-based movements; returns push success details, or — if a name cannot be resolved — the candidate movements to choose from.",
  inputSchema: z.object({
    title: z
      .string()
      .describe(
        'Short descriptive name: target area + style. Do NOT include dates. Examples: "Upper Body Strength", "Leg Day – Quad Focus", "Push – Chest & Triceps".',
      ),
    blocks: z
      .array(
        z.object({
          exercises: z
            .array(
              z.object({
                name: z
                  .string()
                  .optional()
                  .describe(
                    'Exercise name from search_exercises, e.g. "Alternating Bench Press". Always provide this for real exercises — the server resolves it to the real Tonal catalog ID, so a missing or guessed movementId is repaired automatically. Optional only for the synthetic Rest sentinel, which is identified by movementId.',
                  ),
                movementId: z
                  .string()
                  .optional()
                  .describe(
                    "Tonal catalog UUID from search_exercises (or the Rest sentinel). Optional for real exercises — the server resolves by name when it is missing or invalid. Never fabricate one.",
                  ),
                sets: z.number().int().min(1).max(10).default(3),
                // Keep reps/duration permissive: non-positive values are normalized to
                // safe defaults in buildSet before the Tonal push (#447). Rejecting here
                // would skip that repair on the one-off create_workout path and still fail.
                reps: z.number().int().optional(),
                duration: z.number().int().optional(),
                spotter: z.boolean().default(false),
                eccentric: z.boolean().default(false),
                warmUp: z.boolean().default(false),
              }),
            )
            .min(1)
            .max(6),
        }),
      )
      .min(1)
      .max(10),
  }),
  inputExamples: [
    {
      input: {
        title: "Upper Body Strength",
        blocks: [
          {
            exercises: [
              {
                name: "Bench Press",
                movementId: "movement-id-from-search-exercises-1",
                sets: 3,
                reps: 10,
                spotter: false,
                eccentric: false,
                warmUp: false,
              },
              {
                name: "Plank",
                movementId: "duration-movement-id-from-search",
                sets: 3,
                duration: 30,
                spotter: false,
                eccentric: false,
                warmUp: false,
              },
            ],
          },
        ],
      },
    },
  ],
  needsApproval: true,
  execute: withToolTracking(
    "create_workout",
    async (
      ctx,
      input,
      _options,
    ): Promise<
      | {
          success: true;
          workoutId: string;
          title: string;
          setCount: number;
          planId: string;
          divergenceWarning?: string;
        }
      | { success: false; error: string }
    > => {
      const userId = requireUserId(ctx);

      // Resolve each exercise to a real Tonal catalog ID. The coach frequently
      // supplies a fabricated or stale UUID instead of calling search_exercises; fall
      // back to the exercise name and repair the ID rather than hard-stopping the push.
      const catalog: Movement[] = await ctx.runQuery(
        internal.tonal.movementSync.getAllMovements,
        {},
      );
      const resolved = resolveWorkoutBlocks(input.blocks, catalog);
      if (!resolved.ok) {
        return { success: false, error: resolved.error };
      }

      const pushed = await ctx.runAction(internal.tonal.mutations.createWorkout, {
        userId,
        title: input.title,
        blocks: resolved.blocks,
      });

      if (!pushed.success) return pushed;

      // Strip pushDivergence from the LLM-visible return; it is a structured object
      // the LLM has no schema for. Surface only a human-readable warning when needed.
      const { pushDivergence: _pushDivergence, ...pushedSummary } = pushed;

      if (
        _pushDivergence &&
        (_pushDivergence.missingMovements.length > 0 ||
          _pushDivergence.extraMovements.length > 0 ||
          _pushDivergence.setCountMismatches.length > 0)
      ) {
        console.warn(`createWorkoutTool: divergence on ${pushed.workoutId}`, _pushDivergence);
        return {
          ...pushedSummary,
          divergenceWarning: `WARNING: Tonal stored the workout differently than sent. Missing movements: ${_pushDivergence.missingMovements.length}. Set-count mismatches: ${_pushDivergence.setCountMismatches.length}. Tell the user to verify the workout on their Tonal.`,
        };
      }

      return pushedSummary;
    },
  ),
});
export const deleteWorkoutTool = createTool({
  description:
    "Delete a standalone custom workout from Tonal by workoutId. Use when the user explicitly wants a custom workout removed from Tonal. Do not use to discard a draft weekly plan or remove one day from the current week; use delete_week_plan or week modification tools for that. Input is a Tonal workoutId; returns deleted:true when the removal succeeds.",
  inputSchema: z.object({
    workoutId: z.string().describe("Tonal workout ID"),
  }),
  needsApproval: true,
  execute: withToolTracking(
    "delete_workout",
    async (ctx, input, _options): Promise<{ deleted: true }> => {
      const userId = requireUserId(ctx);
      return (await ctx.runAction(internal.tonal.mutations.deleteWorkout, {
        userId,
        workoutId: input.workoutId,
      })) as { deleted: true };
    },
  ),
});
