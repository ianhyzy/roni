import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import { requireUserId, withToolTracking } from "./helpers";

export const estimateDurationTool = createTool({
  description:
    "Estimate workout duration from proposed exercise blocks before creating or rebuilding a workout. Use when the coach needs to check whether a manually authored block layout is likely to fit the user's time target. Do not use for weekly algorithmic programming, completed workout duration, or Tonal push status. Inputs are blocks with searched movementIds, sets, and reps or duration seconds; returns estimatedMinutes or a validation error.",
  inputSchema: z.object({
    blocks: z
      .array(
        z.object({
          exercises: z
            .array(
              z.object({
                movementId: z.string(),
                sets: z.number().int().min(1).max(10).default(3),
                reps: z.number().int().optional(),
                duration: z.number().int().optional(),
              }),
            )
            .min(1),
        }),
      )
      .min(1),
  }),
  execute: withToolTracking(
    "estimate_duration",
    async (
      ctx,
      input,
      _options,
    ): Promise<{ success: true; estimatedMinutes: number } | { success: false; error: string }> => {
      const userId = requireUserId(ctx);
      try {
        const result = (await ctx.runAction(internal.tonal.mutations.estimateWorkout, {
          userId,
          blocks: input.blocks,
        })) as { duration: number };
        return { success: true, estimatedMinutes: Math.round(result.duration / 60) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          error: `Could not estimate duration: ${msg}. Verify every movementId came from search_exercises and that each exercise has sets ≥ 1.`,
        };
      }
    },
  ),
});
