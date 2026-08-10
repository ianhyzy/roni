/**
 * AI coach tools for the 7 new coaching features:
 * 1. Post-workout feedback (RPE/rating)
 * 2. Periodization / deload management
 * 3. Measurable goal tracking
 * 4. Dynamic injury management
 * 5. Warm-up guidance (prompt-only, no tool needed)
 * 6. Volume tracking per muscle group
 * 7. Exercise rotation (built into selection engine, no tool needed)
 */

import { createTool } from "@convex-dev/agent";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { requireUserId, withToolTracking } from "./helpers";
import { computeWeeklyVolume } from "../coach/periodization";
import { getWeekStartDateStringInTimezone } from "../weekPlanHelpers";

// ---------------------------------------------------------------------------
// 1. Post-workout feedback
// ---------------------------------------------------------------------------

export const recordFeedbackTool = createTool({
  description:
    "Record post-workout feedback from the user. Use when the user gives an RPE, session rating, or notes about a completed workout. Do not use before identifying the completed activity or for general mood check-ins unrelated to a workout. Inputs require activityId, RPE, rating, and optional notes; returns the recorded RPE and rating.",
  inputSchema: z.object({
    activityId: z.string().describe("Tonal activity ID for the workout"),
    rpe: z
      .number()
      .min(1)
      .max(10)
      .describe("Rate of Perceived Exertion: 1 (very easy) to 10 (max effort)"),
    rating: z.number().min(1).max(5).describe("Session rating: 1 (terrible) to 5 (great)"),
    notes: z.string().optional().describe("Optional notes from the user"),
  }),
  execute: withToolTracking("record_feedback", async (ctx, input, _options) => {
    const userId = requireUserId(ctx);
    await ctx.runMutation(internal.workoutFeedback.submitInternal, {
      userId: userId as Id<"users">,
      activityId: input.activityId,
      rpe: input.rpe,
      rating: input.rating,
      notes: input.notes,
    });
    return { recorded: true, rpe: input.rpe, rating: input.rating };
  }),
});

export const getRecentFeedbackTool = createTool({
  description:
    "Get recent workout feedback entries with RPE, ratings, notes, and dates. Use when adjusting training load, deciding whether fatigue is accumulating, or contextualizing a user's recent experience. Do not use for objective performance trends, workout history, or muscle readiness. Input is an optional limit; returns recent feedback rows.",
  inputSchema: z.object({
    limit: z.number().optional().default(5).describe("Number of recent entries"),
  }),
  execute: withToolTracking("get_recent_feedback", async (ctx, input, _options) => {
    const userId = requireUserId(ctx);
    const feedback = (await ctx.runQuery(internal.workoutFeedback.getRecentInternal, {
      userId: userId as Id<"users">,
      limit: input.limit,
    })) as Doc<"workoutFeedback">[];
    return feedback.map((f) => ({
      activityId: f.activityId,
      rpe: f.rpe,
      rating: f.rating,
      notes: f.notes,
      date: new Date(f.createdAt).toISOString().slice(0, 10),
    }));
  }),
});

// ---------------------------------------------------------------------------
// 2. Periodization / deload
// ---------------------------------------------------------------------------

export const checkDeloadTool = createTool({
  description:
    "Check whether the user should take a deload week based on their current training block and recent RPE. Use before programming a new week or when the user reports unusually high fatigue. Do not use as a medical assessment or as a substitute for pain/injury handling. Inputs are empty; returns shouldDeload, reason, and current block details.",
  inputSchema: z.object({}),
  execute: withToolTracking("check_deload", async (ctx, _input, _options) => {
    const userId = requireUserId(ctx);
    const result = (await ctx.runQuery(internal.coach.periodization.shouldDeload, {
      userId: userId as Id<"users">,
    })) as {
      shouldDeload: boolean;
      reason: string;
      activeBlock: Doc<"trainingBlocks"> | null;
    };
    return {
      shouldDeload: result.shouldDeload,
      reason: result.reason,
      currentBlock: result.activeBlock
        ? {
            type: result.activeBlock.blockType,
            week: result.activeBlock.weekNumber,
            totalWeeks: result.activeBlock.totalWeeks,
            label: result.activeBlock.label,
          }
        : null,
    };
  }),
});

export const startTrainingBlockTool = createTool({
  description:
    "Start a new training block or mesocycle. Use when the user begins structured programming, switches block focus, or needs a building, deload, or testing block established. Do not use to advance an existing block one week or to create individual workouts. Inputs require blockType, totalWeeks, and optional label; returns the started block type and length.",
  inputSchema: z.object({
    blockType: z.enum(["building", "deload", "testing"]),
    totalWeeks: z.number().min(1).max(8).describe("How many weeks for this block"),
    label: z.string().optional().describe("Custom label like 'Hypertrophy Phase'"),
  }),
  execute: withToolTracking(
    "start_training_block",
    async (
      ctx,
      input,
      _options,
    ): Promise<{ started: boolean; blockType: string; totalWeeks: number }> => {
      const userId = requireUserId(ctx);
      const startDate = new Date().toISOString().slice(0, 10);
      await ctx.runMutation(internal.coach.periodization.startBlock, {
        userId: userId as Id<"users">,
        blockType: input.blockType,
        totalWeeks: input.totalWeeks,
        startDate,
        label: input.label,
      });
      return { started: true, blockType: input.blockType, totalWeeks: input.totalWeeks };
    },
  ),
});

export const advanceTrainingBlockTool = createTool({
  description:
    "Advance the current training block to the next week. Use after a new training week has been programmed and the block state should move forward. Do not use to start a brand-new mesocycle, force a deload decision, or update workout performance. Inputs are empty; returns whether a transition occurred and the new block summary.",
  inputSchema: z.object({}),
  execute: withToolTracking("advance_training_block", async (ctx, _input, _options) => {
    const userId = requireUserId(ctx);
    const result = (await ctx.runMutation(internal.coach.periodization.advanceWeek, {
      userId: userId as Id<"users">,
    })) as { advanced: boolean; transitioned: boolean; newBlock: Doc<"trainingBlocks"> | null };
    return {
      advanced: result.advanced,
      transitioned: result.transitioned,
      newBlock: result.newBlock
        ? { type: result.newBlock.blockType, label: result.newBlock.label }
        : null,
    };
  }),
});

// ---------------------------------------------------------------------------
// 3. Goal tracking
// ---------------------------------------------------------------------------

export const setGoalTool = createTool({
  description:
    "Create a measurable training goal with a target value and deadline. Use when the user sets a specific strength, volume, consistency, or body-composition target that can be tracked numerically. Do not use for vague aspirations without a metric, current progress updates, or completed-goal celebration; use update_goal_progress for progress changes. Inputs require title, category, metric, baselineValue, targetValue, and ISO deadline; returns created:true and initial progress.",
  inputSchema: z.object({
    title: z.string().describe("Goal description"),
    category: z.enum(["strength", "volume", "consistency", "body_composition"]),
    metric: z.string().describe("What's being measured, e.g. 'bench_press_avg_weight'"),
    baselineValue: z.number().describe("Starting value"),
    targetValue: z.number().describe("Target value"),
    deadline: z.string().describe("ISO date string deadline, e.g. 2026-06-01"),
  }),
  inputExamples: [
    {
      input: {
        title: "Increase bench press average weight to 85 lbs",
        category: "strength",
        metric: "bench_press_avg_weight_lbs",
        baselineValue: 65,
        targetValue: 85,
        deadline: "2026-06-01",
      },
    },
    {
      input: {
        title: "Complete 4 Tonal sessions per week",
        category: "consistency",
        metric: "weekly_tonal_sessions",
        baselineValue: 2,
        targetValue: 4,
        deadline: "2026-07-01",
      },
    },
  ],
  execute: withToolTracking(
    "set_goal",
    async (ctx, input, _options): Promise<{ created: boolean; progress: string }> => {
      const userId = requireUserId(ctx);
      await ctx.runMutation(internal.goals.createInternal, {
        userId: userId as Id<"users">,
        ...input,
      });
      return { created: true, progress: "0%" };
    },
  ),
});

export const updateGoalProgressTool = createTool({
  description:
    "Update the current value for an existing measurable training goal. Use after workout analysis or user-provided data shows progress toward a saved goal. Do not use to create a new goal, infer progress without data, or update goals unrelated to training metrics. Inputs require goalId and currentValue; returns updated:true, whether the target was reached, and the stored current value.",
  inputSchema: z.object({
    goalId: z.string().describe("Goal ID"),
    currentValue: z.number().describe("Updated current value"),
  }),
  execute: withToolTracking("update_goal_progress", async (ctx, input, _options) => {
    const userId = requireUserId(ctx);
    const result = (await ctx.runMutation(internal.goals.updateProgressInternal, {
      goalId: input.goalId as Id<"goals">,
      userId: userId as Id<"users">,
      currentValue: input.currentValue,
    })) as { reached: boolean };
    return { updated: true, reached: result.reached, currentValue: input.currentValue };
  }),
});

export const getGoalsTool = createTool({
  description:
    "Get the user's active training goals with computed progress. Use when tailoring coaching to saved goals, checking whether workout analysis affects a goal, or reminding the user what they are chasing. Do not use to create or update goal values. Inputs are empty; returns active goals with goalId, title, category, baseline, current, target, progress, and deadline.",
  inputSchema: z.object({}),
  execute: withToolTracking("get_goals", async (ctx, _input, _options) => {
    const userId = requireUserId(ctx);
    const goals = (await ctx.runQuery(internal.goals.getActiveInternal, {
      userId: userId as Id<"users">,
    })) as Doc<"goals">[];
    return goals.map((g) => {
      const range = Math.abs(g.targetValue - g.baselineValue);
      const progress =
        range === 0 ? 100 : (Math.abs(g.currentValue - g.baselineValue) / range) * 100;
      return {
        goalId: g._id,
        title: g.title,
        category: g.category,
        baseline: g.baselineValue,
        current: g.currentValue,
        target: g.targetValue,
        progress: `${Math.min(100, Math.round(progress))}%`,
        deadline: g.deadline,
      };
    });
  }),
});

// ---------------------------------------------------------------------------
// 4. Injury management
// ---------------------------------------------------------------------------

export const reportInjuryTool = createTool({
  description:
    "Record a new injury, pain report, or physical limitation. Use when the user reports pain, discomfort beyond normal soreness, or a movement restriction that should affect future programming. Do not use for ordinary post-workout fatigue, resolved injuries, or a plain dislike of a movement — use exclude_exercises for exercises the user simply never wants programmed. Inputs require area, severity, avoidance keywords, and optional notes; returns the recorded area and severity.",
  inputSchema: z.object({
    area: z.string().describe("Body area: 'left shoulder', 'lower back', 'right knee', etc."),
    severity: z.enum(["mild", "moderate", "severe"]),
    avoidance: z
      .string()
      .describe(
        "What to avoid in exercise names, comma-separated. E.g. 'overhead, press' or 'deadlift, squat'",
      ),
    notes: z.string().optional(),
  }),
  execute: withToolTracking(
    "report_injury",
    async (
      ctx,
      input,
      _options,
    ): Promise<{ recorded: boolean; area: string; severity: string }> => {
      const userId = requireUserId(ctx);
      await ctx.runMutation(internal.injuries.reportInternal, {
        userId: userId as Id<"users">,
        area: input.area,
        severity: input.severity,
        avoidance: input.avoidance,
        notes: input.notes,
      });
      return { recorded: true, area: input.area, severity: input.severity };
    },
  ),
});

export const resolveInjuryTool = createTool({
  description:
    "Mark an active injury or limitation as resolved. Use only after the user confirms the issue has improved enough that restrictions can be lifted. Do not use for new pain reports, partial limitations, or temporary workout substitutions. Input is injuryId from get_injuries; returns resolved:true.",
  inputSchema: z.object({
    injuryId: z.string().describe("Injury ID to resolve"),
  }),
  execute: withToolTracking("resolve_injury", async (ctx, input, _options) => {
    const userId = requireUserId(ctx);
    await ctx.runMutation(internal.injuries.resolveInternal, {
      injuryId: input.injuryId as Id<"injuries">,
      userId: userId as Id<"users">,
    });
    return { resolved: true };
  }),
});

export const getInjuriesTool = createTool({
  description:
    "Get the user's active injuries and limitations. Use before programming around pain, checking why movements are excluded, or confirming whether restrictions are still active. Do not use for general soreness or muscle readiness. Inputs are empty; returns active injury IDs, areas, severity, avoidance keywords, notes, and reported dates.",
  inputSchema: z.object({}),
  execute: withToolTracking("get_injuries", async (ctx, _input, _options) => {
    const userId = requireUserId(ctx);
    const injuries = (await ctx.runQuery(internal.injuries.getActiveInternal, {
      userId: userId as Id<"users">,
    })) as Doc<"injuries">[];
    return injuries.map((i) => ({
      injuryId: i._id,
      area: i.area,
      severity: i.severity,
      avoidance: i.avoidance,
      notes: i.notes,
      reportedAt: new Date(i.reportedAt).toISOString().slice(0, 10),
    }));
  }),
});

// ---------------------------------------------------------------------------
// 6. Volume tracking
// ---------------------------------------------------------------------------

export function createGetWeeklyVolumeTool(userTimezone?: string) {
  return createTool({
    description:
      "Analyze current weekly training volume by muscle group against recommended set ranges. Use when the user asks about under-training, over-training, bodybuilding balance, or whether the current week has enough volume. Do not use for recent workout frequency, muscle readiness, or per-exercise performance trends. Inputs are empty; returns weekStartDate and muscle-group volume rows with weeklySets, recommended range, and status.",
    inputSchema: z.object({}),
    execute: withToolTracking("get_weekly_volume", async (ctx, _input, _options) => {
      const userId = requireUserId(ctx);
      const typedUserId = userId as Id<"users">;

      // Get current week's workout plans
      const weekStartDate = getWeekStartDateStringInTimezone(new Date(), userTimezone);
      const weekPlan = (await ctx.runQuery(internal.weekPlans.getByUserIdAndWeekStartInternal, {
        userId: typedUserId,
        weekStartDate,
      })) as Doc<"weekPlans"> | null;

      if (!weekPlan) return { message: "No week plan found for current week.", volume: [] };

      // Get workout plan blocks for each day
      const planIds = weekPlan.days
        .map((d) => d.workoutPlanId)
        .filter((id): id is Id<"workoutPlans"> => id !== undefined);

      const plans = (await Promise.all(
        [...new Set(planIds)].map((id) =>
          ctx.runQuery(internal.workoutPlans.getById, { planId: id, userId: typedUserId }),
        ),
      )) as (Doc<"workoutPlans"> | null)[];

      const weekBlocks = plans
        .filter((p): p is Doc<"workoutPlans"> => p !== null)
        .map((p) => p.blocks);

      // Get catalog for muscle group mapping
      const catalog = await ctx.runQuery(internal.tonal.movementSync.getAllMovements);

      const volume = computeWeeklyVolume(weekBlocks, catalog);
      return {
        weekStartDate,
        volume: volume.map((v) => ({
          muscleGroup: v.muscleGroup,
          weeklySets: v.weeklySets,
          recommended: `${v.recommendedMin}-${v.recommendedMax}`,
          status: v.status,
        })),
      };
    }),
  });
}

export const getWeeklyVolumeTool = createGetWeeklyVolumeTool();
