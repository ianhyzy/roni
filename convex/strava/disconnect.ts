import { isRateLimitError } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, type ActionCtx, internalAction } from "../_generated/server";
import { rateLimiter } from "../rateLimits";
import { revokeEncryptedStravaToken } from "./tokenRevocation";

const DISCONNECT_POLL_DEADLINE_MS = 5_000;
const MIN_DISCONNECT_POLL_MS = 100;

type DisconnectClaim =
  | null
  | { state: "leased"; retryAfterMs: number }
  | { state: "claimed"; generation: string; accessTokenEncrypted: string };

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function claimConnectionForDisconnect(
  ctx: Pick<ActionCtx, "runMutation">,
  userId: Id<"users">,
  reason: "user_disconnected" | "account_deleted",
): Promise<DisconnectClaim> {
  const deadline = Date.now() + DISCONNECT_POLL_DEADLINE_MS;
  let latestLease: Extract<DisconnectClaim, { state: "leased" }> | null = null;
  while (true) {
    if (latestLease && Date.now() >= deadline) return latestLease;
    const claim: DisconnectClaim = await ctx.runMutation(
      internal.strava.connections.claimDisconnect,
      { userId, reason, now: Date.now() },
    );
    if (!claim || claim.state === "claimed") {
      return claim;
    }
    latestLease = claim;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return latestLease;
    await wait(Math.min(remainingMs, Math.max(MIN_DISCONNECT_POLL_MS, claim.retryAfterMs + 25)));
  }
}

export type DisconnectStravaResult =
  | { success: true; revocation: "confirmed" | "failed" | "not_required" }
  | { success: false; retryable: true; error: string };

export const disconnectMyStrava = action({
  args: {},
  handler: async (ctx): Promise<DisconnectStravaResult> => {
    const userId: Id<"users"> | null = await ctx.runQuery(
      internal.lib.auth.resolveEffectiveUserId,
      {},
    );
    if (!userId) throw new Error("Not authenticated");
    try {
      await rateLimiter.limit(ctx, "disconnectMyStrava", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) throw new Error("Too many Strava disconnect attempts");
      throw new Error("Unable to disconnect Strava right now");
    }

    const claimed = await claimConnectionForDisconnect(ctx, userId, "user_disconnected");
    if (!claimed) return { success: true, revocation: "not_required" };
    if (claimed.state === "leased") {
      return {
        success: false,
        retryable: true,
        error: "Strava is finishing a token refresh. Please try disconnecting again.",
      };
    }
    const revoked = await revokeEncryptedStravaToken(claimed.accessTokenEncrypted);
    return { success: true, revocation: revoked ? "confirmed" : "failed" };
  },
});

export const revokeForAccountDeletion = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<boolean> => {
    const claimed = await claimConnectionForDisconnect(ctx, userId, "account_deleted");
    if (!claimed) return true;
    if (claimed.state === "leased") {
      throw new Error("Strava token refresh did not finish before account deletion");
    }
    return revokeEncryptedStravaToken(claimed.accessTokenEncrypted);
  },
});
