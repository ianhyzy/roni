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
import { rateLimiter } from "./rateLimits";
import {
  CLAIMED_WEEK_PLAN_DELETE_ERROR,
  COMPLETED_WEEK_PLAN_DELETE_ERROR,
  WEEK_PLAN_DELETION_IN_PROGRESS_ERROR,
} from "./weekPlanDeletionShared";

export {
  CLAIMED_WEEK_PLAN_DELETE_ERROR,
  COMPLETED_WEEK_PLAN_DELETE_ERROR,
} from "./weekPlanDeletionShared";

type DeletionState =
  | { readonly ok: false; readonly error: string }
  | { readonly ok: true; readonly tonalWorkoutIds: string[] };

const deletionStateValidator = v.union(
  v.object({ ok: v.literal(false), error: v.string() }),
  v.object({ ok: v.literal(true), tonalWorkoutIds: v.array(v.string()) }),
);

/**
 * Classify every workout linked to the plan. Fails closed on a scheduling
 * claim (live or stale — a `post_authorized` claim may have already POSTed)
 * and on completed sessions, which are training history, not drafts.
 */
export const getWeekPlanDeletionState = internalQuery({
  args: { userId: v.id("users"), weekPlanId: v.id("weekPlans") },
  returns: deletionStateValidator,
  handler: async (ctx, args): Promise<DeletionState> => {
    const plan = await ctx.db.get(args.weekPlanId);
    if (!plan) return { ok: true, tonalWorkoutIds: [] };
    if (plan.userId !== args.userId) return { ok: false, error: "Week plan access denied" };
    if (plan.deletionReservation) {
      return { ok: false, error: WEEK_PLAN_DELETION_IN_PROGRESS_ERROR };
    }
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
      if (workout.tonalWorkoutId) {
        const completed = await ctx.db
          .query("completedWorkouts")
          .withIndex("by_userId_tonalWorkoutId", (q) =>
            q.eq("userId", args.userId).eq("tonalWorkoutId", workout.tonalWorkoutId),
          )
          .first();
        if (completed) return { ok: false, error: COMPLETED_WEEK_PLAN_DELETE_ERROR };
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
  | {
      readonly deleted: false;
      readonly status: "blocked" | "needs_attention" | "already_removed";
      readonly message: string;
      readonly retryable: boolean;
      readonly removedFromTonal: number;
    };

/**
 * Delete a week plan and everything it put on Tonal.
 *
 * Tonal deletions happen first: if any of them fails we stop and leave the
 * week plan in place, so the user is never told the week is gone while a
 * workout is still sitting on their machine.
 */
export const deleteWeekPlanWithTonal = internalAction({
  args: { userId: v.id("users"), weekPlanId: v.id("weekPlans") },
  returns: v.union(
    v.object({ deleted: v.literal(true), removedFromTonal: v.number() }),
    v.object({
      deleted: v.literal(false),
      status: v.union(
        v.literal("blocked"),
        v.literal("needs_attention"),
        v.literal("already_removed"),
      ),
      message: v.string(),
      retryable: v.boolean(),
      removedFromTonal: v.number(),
    }),
  ),
  handler: async (ctx, args): Promise<DeleteWeekPlanResult> => {
    await rateLimiter.limit(ctx, "deleteWeekPlan", { key: args.userId, throws: true });
    const reservation = await ctx.runMutation(
      internal.weekPlanDeletionState.reserveWeekPlanDeletion,
      {
        ...args,
        proposedClaimId: crypto.randomUUID(),
        now: Date.now(),
      },
    );
    if (reservation.status === "missing") {
      return {
        deleted: false,
        status: "already_removed",
        message: "The week plan was already removed.",
        retryable: false,
        removedFromTonal: 0,
      };
    }
    if (reservation.status === "conflict") {
      return {
        deleted: false,
        status: "blocked",
        message: reservation.error,
        retryable: false,
        removedFromTonal: 0,
      };
    }

    let removedFromTonal = reservation.targets.filter(
      (target) => target.remoteStatus === "absent",
    ).length;
    for (const target of reservation.targets) {
      if (!target.tonalWorkoutId || target.remoteStatus !== "pending") continue;
      const authorization = await ctx.runMutation(
        internal.weekPlanDeletionState.authorizeRemoteWorkoutDeletion,
        {
          ...args,
          claimId: reservation.claimId,
          workoutPlanId: target.workoutPlanId,
          tonalWorkoutId: target.tonalWorkoutId,
        },
      );
      if (authorization.status === "skip") continue;
      if (authorization.status === "blocked") {
        return {
          deleted: false,
          status: "needs_attention",
          message: authorization.error,
          retryable: false,
          removedFromTonal,
        };
      }
      try {
        await ctx.runAction(internal.tonal.mutations.deleteWorkoutFromTonal, {
          userId: args.userId,
          workoutId: target.tonalWorkoutId,
        });
        const confirmed = await ctx.runMutation(
          internal.weekPlanDeletionState.confirmRemoteWorkoutDeletion,
          {
            ...args,
            claimId: reservation.claimId,
            workoutPlanId: target.workoutPlanId,
            tonalWorkoutId: target.tonalWorkoutId,
          },
        );
        if (!confirmed.confirmed) {
          return {
            deleted: false,
            status: "needs_attention",
            message:
              "Tonal confirmed a deletion, but its local receipt could not be saved. Retry to reconcile it.",
            retryable: true,
            removedFromTonal,
          };
        }
        removedFromTonal += 1;
      } catch (error) {
        await ctx.runMutation(internal.weekPlanDeletionState.markDeletionNeedsAttention, {
          ...args,
          claimId: reservation.claimId,
        });
        const reason = error instanceof Error ? error.message : "unknown error";
        return {
          deleted: false,
          status: "needs_attention",
          message: `Confirmed ${removedFromTonal} remote removals, then Tonal returned an ambiguous failure (${reason}). The local week was preserved; retry to reconcile the remaining targets.`,
          retryable: true,
          removedFromTonal,
        };
      }
    }

    const deletion = await ctx.runMutation(
      internal.weekPlanDeletionState.finalizeWeekPlanDeletion,
      { ...args, claimId: reservation.claimId },
    );
    if (!deletion.ok) {
      return {
        deleted: false,
        status: "needs_attention",
        message: deletion.error,
        retryable: false,
        removedFromTonal,
      };
    }
    if (!deletion.deleted) {
      return {
        deleted: false,
        status: "already_removed",
        message: "The week plan was already removed.",
        retryable: false,
        removedFromTonal,
      };
    }
    return { deleted: true, removedFromTonal };
  },
});

export const deleteWeekPlanInternal = internalMutation({
  args: {
    userId: v.id("users"),
    weekPlanId: v.id("weekPlans"),
    /** Legacy callers may pass this, but pushed rows always require reservation receipts. */
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
    if (plan.deletionReservation) {
      return { ok: false as const, error: "This week plan is being deleted" };
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
      const blocker = getDraftWorkoutMutationBlocker(workout);
      if (blocker === "non_draft") {
        return { ok: false as const, error: "Only draft week plans can be deleted" };
      }
      if (blocker === "scheduled") {
        return { ok: false as const, error: "Scheduled workouts cannot be deleted" };
      }
    }

    for (const workoutPlanId of workoutPlanIds) {
      await ctx.db.delete(workoutPlanId);
    }
    await ctx.db.delete(args.weekPlanId);
    return { ok: true as const, deleted: true };
  },
});
