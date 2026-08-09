import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { isValidWeekStartDateString } from "../weekPlanHelpers";
import { isWorkoutReservedForWeekPlanDeletion } from "../weekPlanDeletionShared";

export const SCHEDULING_RECEIPT_FRESH_MS = 10 * 60 * 1000;
export const SCHEDULING_CLAIM_LEASE_MS = 11 * 60 * 1000;

const receiptTargetArgs = {
  userId: v.id("users"),
  workoutPlanId: v.id("workoutPlans"),
  workoutId: v.string(),
  scheduledDate: v.string(),
};

const claimPhaseValidator = v.union(
  v.literal("checking"),
  v.literal("reconciling"),
  v.literal("post_authorized"),
);

const acquireClaimResultValidator = v.union(
  v.object({ status: v.literal("already_scheduled"), workoutSignupId: v.string() }),
  v.object({ status: v.literal("acquired"), phase: claimPhaseValidator }),
  v.object({ status: v.literal("busy"), retryable: v.literal(true) }),
);

function validateTarget(workoutId: string, scheduledDate: string): void {
  if (workoutId.trim() === "" || !isValidWeekStartDateString(scheduledDate)) {
    throw new Error("Invalid Tonal scheduling receipt target");
  }
}

function validateNow(now: number): void {
  if (!Number.isFinite(now) || now < 0) throw new Error("Invalid scheduling timestamp");
}

function assertMatchingPlan(
  plan: Doc<"workoutPlans"> | null,
  userId: Doc<"workoutPlans">["userId"],
  workoutId: string,
): asserts plan is Doc<"workoutPlans"> {
  if (!plan) throw new Error("Workout plan not found");
  if (plan.userId !== userId) throw new Error("Workout plan not owned by user");
  if (plan.tonalWorkoutId !== workoutId) {
    throw new Error("Workout plan does not match Tonal workout");
  }
}

function freshReceipt(
  plan: Doc<"workoutPlans">,
  scheduledDate: string,
  now: number,
): string | null {
  if (
    !plan.tonalWorkoutSignupId ||
    plan.tonalScheduledDate !== scheduledDate ||
    plan.tonalSchedulingReceiptVerifiedAt === undefined ||
    plan.tonalSchedulingReceiptVerifiedAt < now - SCHEDULING_RECEIPT_FRESH_MS
  ) {
    return null;
  }
  return plan.tonalWorkoutSignupId;
}

/** Atomically claim the right to reconcile and, later, authorize one Tonal POST. */
export const acquireClaim = internalMutation({
  args: { ...receiptTargetArgs, claimId: v.string(), now: v.number() },
  returns: acquireClaimResultValidator,
  handler: async (ctx, { userId, workoutPlanId, workoutId, scheduledDate, claimId, now }) => {
    validateTarget(workoutId, scheduledDate);
    validateNow(now);
    if (claimId.trim() === "") throw new Error("Invalid Tonal scheduling claim");

    const plan = await ctx.db.get(workoutPlanId);
    assertMatchingPlan(plan, userId, workoutId);
    if (isWorkoutReservedForWeekPlanDeletion(plan)) {
      return { status: "busy" as const, retryable: true as const };
    }
    const workoutSignupId = freshReceipt(plan, scheduledDate, now);
    if (workoutSignupId) return { status: "already_scheduled" as const, workoutSignupId };

    if (plan.tonalSchedulingClaim && plan.tonalSchedulingClaim.leaseExpiresAt > now) {
      return { status: "busy" as const, retryable: true as const };
    }

    const phase = plan.tonalSchedulingClaim ? ("reconciling" as const) : ("checking" as const);
    await ctx.db.patch(workoutPlanId, {
      tonalSchedulingClaim: {
        claimId: claimId.trim(),
        workoutId,
        scheduledDate,
        phase,
        leaseExpiresAt: now + SCHEDULING_CLAIM_LEASE_MS,
      },
    });
    return { status: "acquired" as const, phase };
  },
});

/** Authorize the only POST after this claim observed a successful live absence. */
export const authorizePost = internalMutation({
  args: { ...receiptTargetArgs, claimId: v.string(), now: v.number() },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), error: v.string(), retryable: v.literal(true) }),
  ),
  handler: async (ctx, { userId, workoutPlanId, workoutId, scheduledDate, claimId, now }) => {
    validateTarget(workoutId, scheduledDate);
    validateNow(now);
    const plan = await ctx.db.get(workoutPlanId);
    assertMatchingPlan(plan, userId, workoutId);
    if (isWorkoutReservedForWeekPlanDeletion(plan)) {
      return {
        ok: false as const,
        error: "The linked week plan is being deleted. Please retry later.",
        retryable: true as const,
      };
    }
    const claim = plan.tonalSchedulingClaim;
    if (
      !claim ||
      claim.claimId !== claimId ||
      claim.workoutId !== workoutId ||
      claim.scheduledDate !== scheduledDate ||
      claim.leaseExpiresAt <= now
    ) {
      return {
        ok: false as const,
        error: "Tonal calendar scheduling claim expired. Please retry.",
        retryable: true as const,
      };
    }
    if (claim.phase === "post_authorized") return { ok: true as const };
    await ctx.db.patch(workoutPlanId, {
      tonalSchedulingClaim: {
        ...claim,
        phase: "post_authorized",
        leaseExpiresAt: now + SCHEDULING_CLAIM_LEASE_MS,
      },
    });
    return { ok: true as const };
  },
});

/** Persist a freshly observed signup and close its exact claim. */
export const completeClaim = internalMutation({
  args: {
    ...receiptTargetArgs,
    claimId: v.string(),
    workoutSignupId: v.string(),
    observedScheduledDate: v.optional(v.string()),
    verifiedAt: v.number(),
  },
  returns: v.null(),
  handler: async (
    ctx,
    {
      userId,
      workoutPlanId,
      workoutId,
      scheduledDate,
      claimId,
      workoutSignupId,
      observedScheduledDate,
      verifiedAt,
    },
  ) => {
    validateTarget(workoutId, scheduledDate);
    if (observedScheduledDate !== undefined) {
      validateTarget(workoutId, observedScheduledDate);
    }
    validateNow(verifiedAt);
    const normalizedSignupId = workoutSignupId.trim();
    if (normalizedSignupId === "") throw new Error("Invalid Tonal scheduling receipt");

    const plan = await ctx.db.get(workoutPlanId);
    assertMatchingPlan(plan, userId, workoutId);
    const claim = plan.tonalSchedulingClaim;
    if (
      !claim ||
      claim.claimId !== claimId ||
      claim.workoutId !== workoutId ||
      claim.scheduledDate !== scheduledDate
    ) {
      throw new Error("Tonal scheduling claim is no longer owned by this request");
    }
    await ctx.db.patch(workoutPlanId, {
      tonalWorkoutSignupId: normalizedSignupId,
      tonalScheduledDate: observedScheduledDate ?? scheduledDate,
      tonalSchedulingReceiptVerifiedAt: verifiedAt,
      tonalSchedulingClaim: undefined,
    });
    return null;
  },
});

/** Only an initial pre-POST check is safe to abandon without reconciliation. */
export const releaseCheckingClaim = internalMutation({
  args: { ...receiptTargetArgs, claimId: v.string() },
  returns: v.object({ released: v.boolean() }),
  handler: async (ctx, { userId, workoutPlanId, workoutId, scheduledDate, claimId }) => {
    validateTarget(workoutId, scheduledDate);
    const plan = await ctx.db.get(workoutPlanId);
    assertMatchingPlan(plan, userId, workoutId);
    const claim = plan.tonalSchedulingClaim;
    if (
      !claim ||
      claim.claimId !== claimId ||
      claim.workoutId !== workoutId ||
      claim.scheduledDate !== scheduledDate ||
      claim.phase !== "checking"
    ) {
      return { released: false };
    }
    await ctx.db.patch(workoutPlanId, { tonalSchedulingClaim: undefined });
    return { released: true };
  },
});
