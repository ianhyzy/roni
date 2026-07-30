/**
 * AI agent tool for full-block authoring inside an existing week plan.
 *
 * Wraps the `internal.coach.rebuildDay.rebuildDay` action. Prefer over
 * `create_workout` for in-week-plan edits, since `create_workout` writes to
 * Tonal Custom Workouts and is not linked to the weekly schedule.
 */

import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { DAY_NAMES } from "../coach/weekProgrammingHelpers";
import { getWeekStartDateStringInTimezone } from "../weekPlanHelpers";
import { requireUserId, withToolTracking } from "./helpers";

export function createRebuildDayTool(userTimezone?: string) {
  return createTool({
    description:
      "Rebuild one draft day's workout inside the current weekly plan with full block authoring. Use when the user wants an unapproved structural rewrite that swap_exercise, add_exercise, set_warmup_block, or adjust_session_duration cannot express, such as a custom warmup plus multiple main blocks and a finisher. Do not use for workouts already pushed to Tonal, standalone custom workouts, full-week programming, simple single-exercise edits, or direct pushes to Tonal. Inputs require dayIndex, optional title, and blocks whose exercises include the exact `name` from search_exercises; movementId is optional/repairable for real exercises. Include reps for rep-based movements or duration seconds for duration-based movements. Returns a draft rebuild message that still requires approve_week_plan to push.",
    inputSchema: z.object({
      dayIndex: z.number().int().min(0).max(6).describe("Day of the week: 0=Monday..6=Sunday"),
      title: z
        .string()
        .optional()
        .describe(
          "Optional override title. If omitted, an auto title is generated (e.g. 'Full body – Monday').",
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
                      'Exact exercise name from search_exercises, e.g. "Alternating Bench Press". Always provide this for real exercises so the server can repair a missing or wrong movementId.',
                    ),
                  movementId: z
                    .string()
                    .optional()
                    .describe(
                      "UUID from search_exercises or the Rest sentinel. Optional for real exercises when exact name is provided; never fabricate one.",
                    ),
                  sets: z.number().int().min(1).max(10).default(3),
                  reps: z.number().int().optional(),
                  duration: z.number().int().optional(),
                  spotter: z.boolean().default(false),
                  eccentric: z.boolean().default(false),
                  warmUp: z.boolean().default(false),
                  chains: z.boolean().optional().describe("Enable chains mode"),
                  burnout: z.boolean().optional().describe("Enable burnout/AMRAP on this exercise"),
                  dropSet: z.boolean().optional().describe("Enable drop set mode"),
                }),
              )
              .min(1)
              .max(6),
          }),
        )
        .min(1)
        .max(10)
        .describe("Block list. Block 0 is conventionally the warmup."),
    }),
    execute: withToolTracking(
      "rebuild_day",
      async (
        ctx,
        input,
        _options,
      ): Promise<{ success: true; message: string } | { success: false; error: string }> => {
        const userId = requireUserId(ctx);
        const weekStartDate = getWeekStartDateStringInTimezone(new Date(), userTimezone);

        const weekPlan = (await ctx.runQuery(internal.weekPlans.getByUserIdAndWeekStartInternal, {
          userId,
          weekStartDate,
        })) as { _id: Id<"weekPlans"> } | null;

        if (!weekPlan) {
          return { success: false, error: "No week plan found for the current week." };
        }

        const result = await ctx.runAction(internal.coach.rebuildDay.rebuildDay, {
          userId,
          weekPlanId: weekPlan._id,
          dayIndex: input.dayIndex,
          title: input.title,
          blocks: input.blocks,
        });
        if (!result.ok) return { success: false, error: result.error };

        const totalExercises = input.blocks.reduce((s, b) => s + b.exercises.length, 0);
        return {
          success: true,
          message: `Rebuilt ${DAY_NAMES[input.dayIndex]} with ${input.blocks.length} blocks and ${totalExercises} exercises. Status: draft. Use approve_week_plan to push to Tonal.`,
        };
      },
    ),
  });
}

export const rebuildDayTool = createRebuildDayTool();
