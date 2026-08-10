import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { getWorkoutApprovalFingerprint } from "../weekPlanHelpers";
import type { PushDivergence } from "../tonal/mutations";
import type { BlockInput } from "../tonal/transforms";

type WorkoutPlan = {
  _id: Id<"workoutPlans">;
  title: string;
  blocks: BlockInput[];
  status: string;
  tonalWorkoutId?: string;
};

type CreateWorkoutResult =
  | {
      success: true;
      workoutId: string;
      title: string;
      planId: Id<"workoutPlans">;
      pushDivergence: PushDivergence | null;
    }
  | { success: false; error: string; planId: Id<"workoutPlans"> };

type ClaimResult =
  | { status: "claimed" }
  | { status: "canonical"; workoutPlanId: Id<"workoutPlans"> }
  | { status: "conflict"; error: string };

type ReplacementResult =
  | { status: "replaced"; workoutPlanId: Id<"workoutPlans"> }
  | { status: "canonical"; workoutPlanId: Id<"workoutPlans"> }
  | { status: "conflict"; error: string };

export type WeekDraftPushResult =
  | { status: "failed"; error: string }
  | { status: "deferred"; error: string }
  | {
      status: "ready";
      workoutPlanId: Id<"workoutPlans">;
      tonalWorkoutId: string;
      title: string;
      blocks: BlockInput[];
      pushDivergence?: PushDivergence | null;
      created: boolean;
    };

/** Single POST on purpose: a failure never proves Tonal rejected the write, so a blind retry can duplicate the remote workout. Transient 5xx and token expiry are already retried inside `createWorkout`. */
async function createTonalWorkout(
  ctx: Pick<ActionCtx, "runAction">,
  userId: Id<"users">,
  workout: WorkoutPlan,
): Promise<CreateWorkoutResult> {
  return (await ctx.runAction(internal.tonal.mutations.createWorkout, {
    userId,
    title: workout.title,
    blocks: workout.blocks,
  })) as CreateWorkoutResult;
}

async function readCanonical(
  ctx: Pick<ActionCtx, "runQuery">,
  userId: Id<"users">,
  workoutPlanId: Id<"workoutPlans">,
): Promise<WeekDraftPushResult> {
  const workout = (await ctx.runQuery(internal.workoutPlans.getById, {
    planId: workoutPlanId,
    userId,
  })) as WorkoutPlan | null;
  if (!workout?.tonalWorkoutId || workout.status !== "pushed") {
    return {
      status: "deferred",
      error: "Approval is still in progress. Retry to finish this day safely.",
    };
  }
  return {
    status: "ready",
    workoutPlanId: workout._id,
    tonalWorkoutId: workout.tonalWorkoutId,
    title: workout.title,
    blocks: workout.blocks,
    created: false,
  };
}

/** Claims the draft before POST and reconciles the exact link after Tonal responds. */
export async function pushDraftForWeekDay(
  ctx: Pick<ActionCtx, "runAction" | "runMutation" | "runQuery">,
  args: {
    userId: Id<"users">;
    weekPlanId: Id<"weekPlans">;
    dayIndex: number;
    workout: WorkoutPlan;
    estimatedDuration?: number;
  },
): Promise<WeekDraftPushResult> {
  const fingerprint = getWorkoutApprovalFingerprint(args.workout);
  const claim = (await ctx.runMutation(internal.weekPlanApproval.claimDraftForWeekPush, {
    userId: args.userId,
    weekPlanId: args.weekPlanId,
    dayIndex: args.dayIndex,
    expectedWorkoutPlanId: args.workout._id,
    expectedDraftFingerprint: fingerprint,
  })) as ClaimResult;
  if (claim.status === "conflict") return { status: "deferred", error: claim.error };
  if (claim.status === "canonical") {
    return readCanonical(ctx, args.userId, claim.workoutPlanId);
  }

  const created = await createTonalWorkout(ctx, args.userId, args.workout);
  if (!created.success) {
    await ctx.runMutation(internal.weekPlanApproval.releaseDraftClaimForWeekPush, {
      userId: args.userId,
      workoutPlanId: args.workout._id,
    });
    return { status: "failed", error: created.error };
  }
  const replacement = (await ctx.runMutation(internal.weekPlans.replaceDraftWithPushed, {
    userId: args.userId,
    weekPlanId: args.weekPlanId,
    dayIndex: args.dayIndex,
    oldWorkoutPlanId: args.workout._id,
    expectedDraftFingerprint: fingerprint,
    newWorkoutPlanId: created.planId,
    estimatedDuration: args.estimatedDuration,
  })) as ReplacementResult;
  if (replacement.status === "conflict") {
    return { status: "deferred", error: replacement.error };
  }
  if (replacement.status === "canonical") {
    return readCanonical(ctx, args.userId, replacement.workoutPlanId);
  }
  return {
    status: "ready",
    workoutPlanId: created.planId,
    tonalWorkoutId: created.workoutId,
    title: created.title,
    blocks: args.workout.blocks,
    pushDivergence: created.pushDivergence,
    created: true,
  };
}
