import { v } from "convex/values";
import { type ActionCtx, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { rateLimiter } from "../rateLimits";
import type { Id } from "../_generated/dataModel";
import { retryOn5xx, TonalApiError, tonalFetch } from "./client";
import {
  type BlockInput,
  buildTonalWorkoutSets,
  computePushDivergence,
  enrichPushErrorMessage,
  type PushDivergence,
} from "./transforms";
import { validateWorkoutBlocks } from "./validation";
import type { WorkoutEstimate } from "./types";
import { WORKOUT_SOURCE } from "../workoutPlans";
import { withTokenRetry } from "./tokenRetry";
import { blockInputValidator } from "../validators";
export {
  computePushDivergence,
  correctDurationRepsMismatch,
  enrichPushErrorMessage,
  type PushDivergence,
} from "./transforms";
export { retryOn5xx } from "./client";
async function expireCustomWorkoutsCache(ctx: ActionCtx, userId: Id<"users">): Promise<void> {
  await ctx
    .runMutation(internal.tonal.cache.deleteCacheEntryByType, {
      userId,
      dataType: "customWorkouts",
    })
    .catch((error: unknown) => {
      console.error("Custom workout cache eviction failed", error);
    });
}
/** Pushes to Tonal only — the caller records the plan. Used by createWorkout and retryPush. */
export const pushWorkoutToTonal = internalAction({
  args: {
    userId: v.id("users"),
    title: v.string(),
    blocks: blockInputValidator,
  },
  handler: async (
    ctx,
    { userId, title, blocks },
  ): Promise<
    { id: string; setCount: number; pushDivergence: PushDivergence | null } | { error: string }
  > => {
    const catalog = await ctx.runQuery(internal.tonal.movementSync.getAllMovements);
    if (catalog.length === 0) {
      throw new Error(
        "Movement catalog is empty — cannot validate or create workout. Run movement sync first.",
      );
    }
    const validation = validateWorkoutBlocks(blocks as BlockInput[], catalog);
    if (!validation.valid) {
      throw new Error(
        `Invalid movement IDs. You must use search_exercises to get real IDs from Tonal's catalog. Do not fabricate IDs. Errors: ${validation.errors.join(", ")}`,
      );
    }
    const sets = buildTonalWorkoutSets(blocks as BlockInput[], catalog);
    if (sets.length === 0) {
      return {
        error:
          "pushWorkoutToTonal: no Tonal-compatible sets to push after filtering synthetic movements.",
      };
    }

    const payload = { title, sets, createdSource: "WorkoutBuilder" };
    console.log(
      `createWorkout: "${title}", ${sets.length} sets, movements: ${[...new Set(sets.map((s) => s.movementId))].join(", ")}`,
    );

    const workout = await withTokenRetry(ctx, userId, async (token) => {
      try {
        return await retryOn5xx(() =>
          tonalFetch<{ id: string }>(token, "/v6/user-workouts", {
            method: "POST",
            body: payload,
          }),
        );
      } catch (err) {
        if (err instanceof TonalApiError && err.status === 401) throw err;
        console.error(`createWorkout payload that failed:`, JSON.stringify(payload, null, 2));
        const movementIds = sets.map((s) => s.movementId);
        const errMsg = err instanceof Error ? err.message : String(err);
        return { error: enrichPushErrorMessage(errMsg, title, movementIds) };
      }
    });
    if ("error" in workout) return workout;
    const tonalWorkoutId = workout.id;

    // Real verification: fetch the stored workout and diff against intent.
    let pushDivergence: PushDivergence | null = null;
    try {
      await withTokenRetry(ctx, userId, async (token) => {
        try {
          const stored = await tonalFetch<{
            id: string;
            sets?: { movementId: string; prescribedReps?: number; prescribedDuration?: number }[];
          }>(token, `/v6/user-workouts/${tonalWorkoutId}`);
          if (stored.sets !== undefined) {
            // sets[] in the request is already expanded one-per-set, so each row counts as 1.
            const intended = sets.map((s) => ({ movementId: s.movementId, sets: 1 }));
            pushDivergence = computePushDivergence(intended, stored.sets);
            if (pushDivergence) {
              console.warn(
                `Push divergence on workout ${tonalWorkoutId}:`,
                JSON.stringify(pushDivergence),
              );
            }
          }
        } catch (err) {
          if (err instanceof TonalApiError && err.status === 401) throw err;
          console.warn(`Push verification: read-back failed for ${tonalWorkoutId}`, err);
        }
      });
    } catch (err) {
      // The POST succeeded, so diagnostic read-back failures cannot make creation retryable.
      console.warn(`Push verification: failed for ${tonalWorkoutId}`, err);
    }

    return { id: tonalWorkoutId, setCount: sets.length, pushDivergence };
  },
});

/** Share a custom workout to get a deep link URL. */
export const shareWorkout = internalAction({
  args: {
    userId: v.id("users"),
    workoutId: v.string(),
  },
  handler: async (ctx, { userId, workoutId }): Promise<{ deepLinkUrl: string }> => {
    return withTokenRetry(ctx, userId, async (token, tonalUserId) => {
      const result = await tonalFetch<{ deepLinkUrl: string }>(
        token,
        `/v6/users/${tonalUserId}/user-workouts/${workoutId}/share`,
        { method: "POST" },
      );
      return { deepLinkUrl: result.deepLinkUrl };
    });
  },
});
export const deleteAllCustomWorkouts = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ deleted: number }> => {
    const workouts = await withTokenRetry(ctx, userId, (token) =>
      tonalFetch<Array<{ id: string }>>(token, "/v6/user-workouts"),
    );
    let deleted = 0;
    try {
      for (const w of workouts) {
        const didDelete = await withTokenRetry(ctx, userId, async (token) => {
          try {
            await tonalFetch(token, `/v6/user-workouts/${w.id}`, { method: "DELETE" });
            return true;
          } catch (e) {
            if (e instanceof TonalApiError && e.status === 401) throw e;
            console.error(`Failed to delete workout ${w.id}:`, e);
            return false;
          }
        });
        if (didDelete) {
          deleted++;
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    } finally {
      await expireCustomWorkoutsCache(ctx, userId);
    }
    return { deleted };
  },
});
export function formatTonalTitle(title: string, now?: Date): string {
  const date = (now ?? new Date()).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${date} · ${title}`;
}

/** Create a custom workout on Tonal and record the plan in Convex. */
export const createWorkout = internalAction({
  args: {
    userId: v.id("users"),
    title: v.string(),
    blocks: blockInputValidator,
  },
  handler: async (
    ctx,
    { userId, title, blocks },
  ): Promise<
    | {
        success: true;
        workoutId: string;
        title: string;
        setCount: number;
        planId: Id<"workoutPlans">;
        pushDivergence: PushDivergence | null;
      }
    | { success: false; error: string; planId: Id<"workoutPlans"> }
  > => {
    await rateLimiter.limit(ctx, "createTonalWorkout", { key: userId, throws: true });
    try {
      const tonalTitle = title;
      const pushResult = await ctx.runAction(internal.tonal.mutations.pushWorkoutToTonal, {
        userId,
        title: tonalTitle,
        blocks,
      });
      if ("error" in pushResult) {
        throw new Error(pushResult.error);
      }
      const { id, setCount, pushDivergence } = pushResult;
      const now = Date.now();
      const planId = await ctx.runMutation(internal.workoutPlans.create, {
        userId,
        tonalWorkoutId: id,
        source: WORKOUT_SOURCE,
        title,
        blocks,
        status: "pushed",
        createdAt: now,
        pushedAt: now,
      });
      await expireCustomWorkoutsCache(ctx, userId);

      return {
        success: true,
        workoutId: id,
        title,
        setCount,
        planId,
        pushDivergence,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error("[createWorkout] Tonal push failed", e);
      void ctx.runAction(internal.discord.notifyError, {
        source: "createWorkout",
        message: `Workout push failed for "${title}": ${message}`,
        userId,
      });
      const planId = await ctx.runMutation(internal.workoutPlans.create, {
        userId,
        title,
        blocks,
        status: "failed",
        pushErrorReason: message,
        createdAt: Date.now(),
      });
      return { success: false, error: message, planId };
    }
  },
});

/** Delete a custom workout from Tonal and update Convex records. */
export const deleteWorkout = internalAction({
  args: {
    userId: v.id("users"),
    workoutId: v.string(),
  },
  handler: async (ctx, { userId, workoutId }): Promise<{ deleted: true }> =>
    withTokenRetry(ctx, userId, async (token) => {
      await tonalFetch(token, `/v6/user-workouts/${workoutId}`, {
        method: "DELETE",
      });

      await ctx.runMutation(internal.workoutPlans.markDeleted, {
        tonalWorkoutId: workoutId,
      });

      await expireCustomWorkoutsCache(ctx, userId);

      return { deleted: true };
    }),
});

/** Remote-only idempotent delete used by the week-plan receipt state machine. */
export const deleteWorkoutFromTonal = internalAction({
  args: {
    userId: v.id("users"),
    workoutId: v.string(),
  },
  returns: v.object({ status: v.union(v.literal("deleted"), v.literal("absent")) }),
  handler: async (ctx, { userId, workoutId }) => {
    const status = await withTokenRetry(ctx, userId, async (token) => {
      try {
        await tonalFetch(token, `/v6/user-workouts/${workoutId}`, { method: "DELETE" });
        return "deleted" as const;
      } catch (error) {
        if (error instanceof TonalApiError && error.status === 404) return "absent" as const;
        throw error;
      }
    });
    await expireCustomWorkoutsCache(ctx, userId);
    return { status };
  },
});

export const estimateWorkout = internalAction({
  args: {
    userId: v.id("users"),
    blocks: blockInputValidator,
  },
  handler: async (ctx, { userId, blocks }): Promise<WorkoutEstimate> => {
    const catalog = await ctx.runQuery(internal.tonal.movementSync.getAllMovements);
    const sets = buildTonalWorkoutSets(blocks as BlockInput[], catalog);
    // Reject empty payloads up front; Tonal would otherwise return its
    // misleading "cannot unmarshal object into Go value of type content.SetList"
    // 400 for both empty arrays and JSON-object wrappers.
    if (sets.length === 0) {
      throw new Error(
        "estimateWorkout: no sets to estimate. Verify every exercise has a valid movementId resolvable in the catalog.",
      );
    }
    // Endpoint expects a bare SetList array, not a wrapper object.
    return withTokenRetry(ctx, userId, async (token) =>
      tonalFetch<WorkoutEstimate>(token, "/v6/user-workouts/estimate", {
        method: "POST",
        body: sets,
      }),
    );
  },
});
