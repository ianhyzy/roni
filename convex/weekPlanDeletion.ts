/**
 * Deleting a week plan whose workouts already reached Tonal.
 *
 * The row-level delete in weekPlanInternals is a mutation, so it can only
 * remove Convex rows — which is why it used to refuse anything non-draft and
 * strand the user with a plan they'd pushed. Removing the Tonal side needs an
 * action, so the orchestration lives here: classify, delete remotely, then
 * delete locally.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { getDraftWorkoutMutationBlocker } from "./weekPlanHelpers";

export const COMPLETED_WEEK_PLAN_DELETE_ERROR =
  "This week has completed sessions, so it can't be deleted. Delete the individual draft days instead.";
export const CLAIMED_WEEK_PLAN_DELETE_ERROR =
  "Workout scheduling is in progress for this week. Try again in a minute.";

type DeletionState =
  | { readonly ok: false; readonly error: string }
  | { readonly ok: true; readonly tonalWorkoutIds: string[] };

/**
 * Classify every workout linked to the plan. Fails closed on a scheduling
 * claim (live or stale — a `post_authorized` claim may have already POSTed)
 * and on completed sessions, which are training history, not drafts.
 */
export const getWeekPlanDeletionState = internalQuery({
  args: { userId: v.id("users"), weekPlanId: v.id("weekPlans") },
  handler: async (ctx, args): Promise<DeletionState> => {
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan) return { ok: true, tonalWorkoutIds: [] };
    if (plan.userId !== args.userId) return { ok: false, error: "Week plan access denied" };
    if (plan.days.some((day) => day.status === "completed")) {
      return { ok: false, error: COMPLETED_WEEK_PLAN_DELETE_ERROR };
    }

    const workoutPlanIds = [
      ...new Set(plan.days.flatMap((day) => (day.workoutPlanId ? [day.workoutPlanId] : []))),
    ];

    const tonalWorkoutIds: string[] = [];
    for (const workoutPlanId of workoutPlanIds) {
      const workout = await ctx.db.get(workoutPlanId);
      if (!workout) return { ok: false, error: "Linked workout not found" };
      if (workout.userId !== args.userId) {
        return { ok: false, error: "Linked workout access denied" };
      }
      if (workout.tonalSchedulingClaim !== undefined) {
        return { ok: false, error: CLAIMED_WEEK_PLAN_DELETE_ERROR };
      }
      if (workout.status === "completed") {
        return { ok: false, error: COMPLETED_WEEK_PLAN_DELETE_ERROR };
      }
      if (workout.status !== "draft" && workout.status !== "deleted" && workout.tonalWorkoutId) {
        tonalWorkoutIds.push(workout.tonalWorkoutId);
      }
    }

    return { ok: true, tonalWorkoutIds };
  },
});

export type DeleteWeekPlanResult =
  | { readonly deleted: true; readonly removedFromTonal: number }
  | { readonly deleted: false; readonly message: string };

/**
 * Delete a week plan and everything it put on Tonal.
 *
 * Tonal deletions happen first: if any of them fails we stop and leave the
 * week plan in place, so the user is never told the week is gone while a
 * workout is still sitting on their machine.
 */
export const deleteWeekPlanWithTonal = internalAction({
  args: { userId: v.id("users"), weekPlanId: v.id("weekPlans") },
  handler: async (ctx, args): Promise<DeleteWeekPlanResult> => {
    const state: DeletionState = await ctx.runQuery(
      internal.weekPlanDeletion.getWeekPlanDeletionState,
      args,
    );
    if (!state.ok) return { deleted: false, message: state.error };

    let removedFromTonal = 0;
    for (const workoutId of state.tonalWorkoutIds) {
      try {
        await ctx.runAction(internal.tonal.mutations.deleteWorkout, {
          userId: args.userId,
          workoutId,
        });
        removedFromTonal += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        return {
          deleted: false,
          message: `Removed ${removedFromTonal} of ${state.tonalWorkoutIds.length} workouts from Tonal, then failed on the next one (${reason}). The week plan was left in place — ask me to try again.`,
        };
      }
    }

    const deletion = (await ctx.runMutation(internal.weekPlans.deleteWeekPlanInternal, {
      userId: args.userId,
      weekPlanId: args.weekPlanId,
      allowPushed: true,
    })) as { ok: true; deleted: boolean } | { ok: false; error: string };

    if (!deletion.ok) return { deleted: false, message: deletion.error };
    if (!deletion.deleted) return { deleted: false, message: "The week plan was already removed." };
    return { deleted: true, removedFromTonal };
  },
});

export const deleteWeekPlanInternal = internalMutation({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    // Set only by weekPlanDeletion.deleteWeekPlanWithTonal, which has already
    // removed the pushed workouts from Tonal. Without that, skipping the
    // non-draft guard here would orphan them on the user's machine.
    allowPushed: v.optional(v.boolean()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), deleted: v.boolean() }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan) return { ok: true as const, deleted: false };
    if (plan.userId !== args.userId) {
      return { ok: false as const, error: "Week plan access denied" };
    }
    if (plan.days.some((day) => day.status === "completed")) {
      return { ok: false as const, error: COMPLETED_WEEK_PLAN_DELETE_ERROR };
    }

    const workoutPlanIds = [
      ...new Set(plan.days.flatMap((day) => (day.workoutPlanId ? [day.workoutPlanId] : []))),
    ];
    for (const workoutPlanId of workoutPlanIds) {
      const workout = await ctx.db.get(workoutPlanId);
      if (!workout) {
        return { ok: false as const, error: "Linked workout not found" };
      }
      if (workout.userId !== args.userId) {
        return { ok: false as const, error: "Linked workout access denied" };
      }
      // Checked directly rather than via the blocker, which short-circuits on
      // "non_draft" and would let a pushed workout skip the claim check.
      if (workout.tonalSchedulingClaim !== undefined) {
        return { ok: false as const, error: "Workout scheduling is in progress" };
      }
      if (workout.status === "completed") {
        return { ok: false as const, error: COMPLETED_WEEK_PLAN_DELETE_ERROR };
      }
      if (!args.allowPushed) {
        const blocker = getDraftWorkoutMutationBlocker(workout);
        if (blocker === "non_draft") {
          return { ok: false as const, error: "Only draft week plans can be deleted" };
        }
        if (blocker === "scheduled") {
          return { ok: false as const, error: "Scheduled workouts cannot be deleted" };
        }
      }
    }

    for (const workoutPlanId of workoutPlanIds) {
      await ctx.db.delete(workoutPlanId);
    }
    await ctx.db.delete(args.weekPlanId);
    return { ok: true as const, deleted: true };
  },
});
