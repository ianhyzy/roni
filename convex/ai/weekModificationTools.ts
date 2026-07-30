/**
 * AI agent tools for modifying draft week plans.
 *
 * - swapExerciseTool: replace one exercise with another in a day's workout
 * - moveSessionTool: swap two day slots in the week plan
 * - adjustSessionDurationTool: re-generate exercises for a day with a new duration
 */

import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { DAY_NAMES } from "../coach/weekProgrammingHelpers";
import { getWeekStartDateStringInTimezone } from "../weekPlanHelpers";
import { requireUserId, toSessionDuration, withToolTracking } from "./helpers";

export function createWeekModificationTools(userTimezone?: string) {
  const getCurrentWeekStartDate = () => getWeekStartDateStringInTimezone(new Date(), userTimezone);

  // ---------------------------------------------------------------------------
  // swapExerciseTool
  // ---------------------------------------------------------------------------

  const swapExerciseTool = createTool({
    description:
      "Swap one exercise for another in a specific day's draft workout. Use when the user wants a direct replacement in the current weekly plan and the rest of the day should stay intact. Do not use for standalone workouts, already-pushed Tonal workouts, adding volume, moving sessions, or rebuilding the day structure. Inputs require dayIndex plus oldMovementId and newMovementId from search_exercises; returns a success message or a draft-plan error.",
    inputSchema: z.object({
      dayIndex: z
        .number()
        .int()
        .min(0)
        .max(6)
        .describe("Day of the week: 0=Monday, 1=Tuesday, ..., 6=Sunday"),
      oldMovementId: z.string().describe("The movement ID to replace"),
      newMovementId: z.string().describe("The replacement movement ID (from search_exercises)"),
    }),
    execute: withToolTracking(
      "swap_exercise",
      async (
        ctx,
        input,
        _options,
      ): Promise<{ success: true; message: string } | { success: false; error: string }> => {
        const userId = requireUserId(ctx);
        const weekStartDate = getCurrentWeekStartDate();

        const weekPlan = (await ctx.runQuery(internal.weekPlans.getByUserIdAndWeekStartInternal, {
          userId,
          weekStartDate,
        })) as {
          _id: Id<"weekPlans">;
          days: { workoutPlanId?: Id<"workoutPlans">; sessionType: string }[];
        } | null;

        if (!weekPlan) {
          return { success: false, error: "No week plan found for the current week." };
        }

        const day = weekPlan.days[input.dayIndex];
        if (!day?.workoutPlanId) {
          return {
            success: false,
            error: `No workout linked to ${DAY_NAMES[input.dayIndex]}. Nothing to swap.`,
          };
        }

        const result = await ctx.runMutation(internal.coach.weekModifications.swapExerciseInDraft, {
          userId,
          workoutPlanId: day.workoutPlanId,
          oldMovementId: input.oldMovementId,
          newMovementId: input.newMovementId,
        });
        if (!result.ok) return { success: false, error: result.error };

        return {
          success: true,
          message: `Swapped exercise on ${DAY_NAMES[input.dayIndex]}. Use get_week_plan_details to see the updated plan.`,
        };
      },
    ),
  });

  // ---------------------------------------------------------------------------
  // addExerciseTool
  // ---------------------------------------------------------------------------

  const addExerciseTool = createTool({
    description:
      "Add one exercise to a specific day's draft workout in the current weekly plan. Use when the user wants an extra finisher, isolation movement, warmup movement, or single added exercise without rebuilding the day. Do not use for replacing an existing exercise, authoring several blocks, changing the session duration, standalone workouts, or already-pushed Tonal workouts. Inputs require dayIndex, a movementId from search_exercises, sets, and either reps or duration; returns a success message with updated block and exercise counts or a draft-plan error.",
    inputSchema: z.object({
      dayIndex: z.number().int().min(0).max(6).describe("Day of the week: 0=Monday..6=Sunday"),
      movementId: z.string().describe("The movement ID to add (from search_exercises)"),
      sets: z.number().int().min(1).max(6).describe("Number of sets"),
      reps: z
        .number()
        .int()
        .optional()
        .describe("Reps per set (omit for duration-based exercises)"),
      duration: z
        .number()
        .optional()
        .describe("Duration in seconds (for duration-based exercises like Plank)"),
      eccentric: z.boolean().optional().describe("Enable eccentric mode"),
      spotter: z.boolean().optional().describe("Enable spotter mode"),
      chains: z.boolean().optional().describe("Enable chains mode"),
      burnout: z.boolean().optional().describe("Enable burnout/AMRAP on this exercise"),
      dropSet: z.boolean().optional().describe("Enable drop set mode"),
      warmUp: z
        .boolean()
        .optional()
        .describe(
          "Mark this exercise as a warmup. Sets warmUp:true on the persisted exercise so Tonal renders it as a warmup. Use for mobility, activation, and prep movements at the top of the session.",
        ),
    }),
    inputExamples: [
      {
        input: {
          dayIndex: 2,
          movementId: "movement-id-from-search-exercises",
          sets: 3,
          reps: 12,
          dropSet: true,
        },
      },
      {
        input: {
          dayIndex: 0,
          movementId: "duration-movement-id-from-search",
          sets: 2,
          duration: 30,
          warmUp: true,
        },
      },
    ],
    execute: withToolTracking(
      "add_exercise",
      async (
        ctx,
        input,
        _options,
      ): Promise<{ success: true; message: string } | { success: false; error: string }> => {
        const userId = requireUserId(ctx);
        const weekStartDate = getCurrentWeekStartDate();

        const weekPlan = (await ctx.runQuery(internal.weekPlans.getByUserIdAndWeekStartInternal, {
          userId,
          weekStartDate,
        })) as {
          _id: Id<"weekPlans">;
          days: { workoutPlanId?: Id<"workoutPlans">; sessionType: string }[];
        } | null;

        if (!weekPlan) {
          return { success: false, error: "No week plan found for the current week." };
        }

        const day = weekPlan.days[input.dayIndex];
        if (!day?.workoutPlanId) {
          return {
            success: false,
            error: `No workout linked to ${DAY_NAMES[input.dayIndex]}. Nothing to add to.`,
          };
        }

        const { dayIndex: _, movementId, sets, ...opts } = input;
        const result = await ctx.runMutation(internal.coach.weekModifications.addExerciseToDraft, {
          userId,
          workoutPlanId: day.workoutPlanId,
          movementId,
          sets,
          ...opts,
        });
        if (!result.ok) return { success: false, error: result.error };

        const updated = await ctx.runQuery(internal.workoutPlans.getById, {
          planId: day.workoutPlanId,
          userId,
        });
        const blockCount = updated?.blocks.length ?? -1;
        const exerciseCount = updated?.blocks.reduce((sum, b) => sum + b.exercises.length, 0) ?? -1;

        return {
          success: true,
          message: `Added exercise to ${DAY_NAMES[input.dayIndex]} (now ${blockCount} blocks, ${exerciseCount} exercises). Use get_week_plan_details to see the updated plan.`,
        };
      },
    ),
  });

  // ---------------------------------------------------------------------------
  // setWarmupBlockTool
  // ---------------------------------------------------------------------------

  const setWarmupBlockTool = createTool({
    description:
      "Set the complete warmup block for a specific day's draft workout. Use when the user asks for a specific warmup sequence or multiple prep movements at the start of a day. Do not use for one regular added exercise, replacing a main lift, standalone workouts, or already-pushed Tonal workouts. Inputs require dayIndex and ordered warmup exercises with movementIds from search_exercises; returns a success message or a draft-plan error.",
    inputSchema: z.object({
      dayIndex: z.number().int().min(0).max(6).describe("Day of the week: 0=Monday..6=Sunday"),
      exercises: z
        .array(
          z.object({
            movementId: z.string().describe("UUID from search_exercises"),
            sets: z
              .number()
              .int()
              .min(1)
              .max(4)
              .describe("Sets per warmup movement (typically 1-2)"),
            reps: z.number().int().optional().describe("Reps (omit for duration-based movements)"),
            duration: z
              .number()
              .int()
              .optional()
              .describe("Duration in seconds (for plank, bridge, etc.)"),
          }),
        )
        .min(1)
        .max(5)
        .describe("Warmup movements in execution order. 1-5 movements typical."),
    }),
    execute: withToolTracking(
      "set_warmup_block",
      async (
        ctx,
        input,
        _options,
      ): Promise<{ success: true; message: string } | { success: false; error: string }> => {
        const userId = requireUserId(ctx);
        const weekStartDate = getCurrentWeekStartDate();

        const weekPlan = (await ctx.runQuery(internal.weekPlans.getByUserIdAndWeekStartInternal, {
          userId,
          weekStartDate,
        })) as {
          _id: Id<"weekPlans">;
          days: { workoutPlanId?: Id<"workoutPlans">; sessionType: string }[];
        } | null;

        if (!weekPlan) {
          return { success: false, error: "No week plan found for the current week." };
        }

        const day = weekPlan.days[input.dayIndex];
        if (!day?.workoutPlanId) {
          return {
            success: false,
            error: `No workout linked to ${DAY_NAMES[input.dayIndex]}. Nothing to set warmup on.`,
          };
        }

        const result = await ctx.runMutation(internal.coach.weekModifications.setWarmupBlock, {
          userId,
          workoutPlanId: day.workoutPlanId,
          exercises: input.exercises,
        });
        if (!result.ok) return { success: false, error: result.error };

        return {
          success: true,
          message: `Set warmup block for ${DAY_NAMES[input.dayIndex]} with ${input.exercises.length} movement(s). Use get_week_plan_details to see the updated plan.`,
        };
      },
    ),
  });

  // ---------------------------------------------------------------------------
  // moveSessionTool
  // ---------------------------------------------------------------------------

  const moveSessionTool = createTool({
    description:
      "Move a draft training session inside the current week by swapping two day slots. Use when the user wants an unapproved session moved from one weekday to another while preserving each day's full workout, session type, and status. Do not use for workouts already pushed to Tonal, changing exercises, changing duration, deleting a session, or creating a new week. Inputs require fromDayIndex and toDayIndex; returns a success message or a week-plan error.",
    inputSchema: z.object({
      fromDayIndex: z.number().int().min(0).max(6).describe("Source day index: 0=Monday..6=Sunday"),
      toDayIndex: z
        .number()
        .int()
        .min(0)
        .max(6)
        .describe("Destination day index: 0=Monday..6=Sunday"),
    }),
    execute: withToolTracking(
      "move_session",
      async (
        ctx,
        input,
        _options,
      ): Promise<{ success: true; message: string } | { success: false; error: string }> => {
        const userId = requireUserId(ctx);
        const weekStartDate = getCurrentWeekStartDate();

        const weekPlan = (await ctx.runQuery(internal.weekPlans.getByUserIdAndWeekStartInternal, {
          userId,
          weekStartDate,
        })) as { _id: Id<"weekPlans"> } | null;

        if (!weekPlan) {
          return { success: false, error: "No week plan found for the current week." };
        }

        if (input.fromDayIndex === input.toDayIndex) {
          return { success: false, error: "Source and destination days are the same." };
        }

        const result = await ctx.runMutation(internal.coach.weekDayModifications.swapDaySlots, {
          userId,
          weekPlanId: weekPlan._id,
          fromDayIndex: input.fromDayIndex,
          toDayIndex: input.toDayIndex,
        });
        if (!result.ok) return { success: false, error: result.error };

        return {
          success: true,
          message: `Swapped ${DAY_NAMES[input.fromDayIndex]} and ${DAY_NAMES[input.toDayIndex]}. Use get_week_plan_details to see the updated plan.`,
        };
      },
    ),
  });

  // ---------------------------------------------------------------------------
  // adjustSessionDurationTool
  // ---------------------------------------------------------------------------

  const adjustSessionDurationTool = createTool({
    description:
      "Change the target duration of a specific draft training day in the current week. Use when the user wants an unapproved day shortened or lengthened to 30, 45, or 60 minutes and is comfortable with the algorithm re-selecting exercises. Do not use for workouts already pushed to Tonal, adding one exercise, swapping one exercise, moving a session, or manually authoring blocks. Inputs require dayIndex and newDurationMinutes; returns a success message after a new draft workout replaces the old one.",
    inputSchema: z.object({
      dayIndex: z.number().int().min(0).max(6).describe("Day of the week: 0=Monday..6=Sunday"),
      newDurationMinutes: z.enum(["30", "45", "60"]).describe("New session duration in minutes"),
    }),
    execute: withToolTracking(
      "adjust_session_duration",
      async (
        ctx,
        input,
        _options,
      ): Promise<{ success: true; message: string } | { success: false; error: string }> => {
        const userId = requireUserId(ctx);
        const weekStartDate = getCurrentWeekStartDate();

        const weekPlan = (await ctx.runQuery(internal.weekPlans.getByUserIdAndWeekStartInternal, {
          userId,
          weekStartDate,
        })) as {
          _id: Id<"weekPlans">;
          days: { sessionType: string; workoutPlanId?: Id<"workoutPlans"> }[];
        } | null;

        if (!weekPlan) {
          return { success: false, error: "No week plan found for the current week." };
        }

        const day = weekPlan.days[input.dayIndex];
        if (!day || day.sessionType === "rest" || day.sessionType === "recovery") {
          return {
            success: false,
            error: `${DAY_NAMES[input.dayIndex]} is a ${day?.sessionType ?? "rest"} day. Cannot adjust duration.`,
          };
        }

        const result = await ctx.runAction(internal.coach.weekModifications.adjustDayDuration, {
          userId,
          weekPlanId: weekPlan._id,
          dayIndex: input.dayIndex,
          newDurationMinutes: toSessionDuration(input.newDurationMinutes),
        });
        if (!result.ok) return { success: false, error: result.error };

        return {
          success: true,
          message: `Adjusted ${DAY_NAMES[input.dayIndex]} to ${input.newDurationMinutes} minutes with new exercises. Use get_week_plan_details to see the updated plan.`,
        };
      },
    ),
  });

  return {
    swapExerciseTool,
    addExerciseTool,
    setWarmupBlockTool,
    moveSessionTool,
    adjustSessionDurationTool,
  };
}

export const {
  swapExerciseTool,
  addExerciseTool,
  setWarmupBlockTool,
  moveSessionTool,
  adjustSessionDurationTool,
} = createWeekModificationTools();
