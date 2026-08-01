import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, internalAction } from "../_generated/server";
import { requestStravaApi } from "./apiRequest";
import { parsePublicStravaActivity } from "./activitySchema";
import { STRAVA_API_BASE_URL } from "./config";
import type { ClaimedStravaWebhookEvent } from "./webhook";

const TRANSIENT_RETRY_MS = 30_000;

async function finish(
  ctx: ActionCtx,
  event: ClaimedStravaWebhookEvent,
  status: "processed" | "ignored" | "error",
  errorReason?: string,
): Promise<void> {
  await ctx.runMutation(internal.strava.webhook.finishEvent, {
    eventId: event.eventId,
    status,
    errorReason,
    processingNonce: event.processingNonce,
    now: Date.now(),
  });
}

function responseRetryAfterMs(response: Response, fallback: number): number {
  const raw = response.headers.get("Retry-After");
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(1_000, date - Date.now()) : fallback;
}

async function retry(
  ctx: ActionCtx,
  event: ClaimedStravaWebhookEvent,
  delayMs: number,
  countProviderFailure: boolean,
): Promise<void> {
  await ctx.runMutation(internal.strava.webhookRecovery.retryEvent, {
    eventId: event.eventId,
    attempts: event.attempts,
    processingNonce: event.processingNonce,
    delayMs,
    countProviderFailure,
    now: Date.now(),
  });
}

async function deleteActivity(ctx: ActionCtx, event: ClaimedStravaWebhookEvent): Promise<void> {
  await ctx.runMutation(internal.strava.activityPersistence.deleteActivity, {
    userId: event.userId,
    athleteId: event.ownerId,
    generation: event.connectionGeneration,
    providerActivityId: event.objectId,
  });
}

async function disconnectCurrentConnection(
  ctx: ActionCtx,
  event: ClaimedStravaWebhookEvent,
  reason: "permission_revoked" | "token_invalid",
): Promise<boolean> {
  return ctx.runMutation(internal.strava.syncState.markProviderDisconnected, {
    userId: event.userId,
    generation: event.connectionGeneration,
    reason,
    now: Date.now(),
  });
}

async function processEventHandler(
  ctx: ActionCtx,
  eventId: Id<"stravaWebhookEvents">,
): Promise<void> {
  const event: ClaimedStravaWebhookEvent | null = await ctx.runMutation(
    internal.strava.webhook.claimEvent,
    { eventId, now: Date.now() },
  );
  if (!event) return;
  if (event.objectType === "athlete") {
    if (event.aspectType === "update" && event.updates?.authorized === "false") {
      const confirmation = await requestStravaApi(ctx, {
        identity: { userId: event.userId, generation: event.connectionGeneration },
        url: new URL(`${STRAVA_API_BASE_URL}/athlete`),
      });
      if (!confirmation.success && confirmation.retryable) {
        await retry(
          ctx,
          event,
          confirmation.retryAfterMs ?? TRANSIENT_RETRY_MS,
          confirmation.retryAfterMs === undefined,
        );
        return;
      }
      if (!confirmation.success) {
        if (confirmation.kind !== "authorization_invalid") {
          await finish(
            ctx,
            event,
            confirmation.kind === "connection_changed" ? "ignored" : "error",
            confirmation.kind === "connection_changed"
              ? undefined
              : "Strava authorization confirmation failed",
          );
          return;
        }
        const disconnected = await disconnectCurrentConnection(ctx, event, "permission_revoked");
        await finish(ctx, event, disconnected ? "processed" : "ignored");
        return;
      }
      if (confirmation.response.status === 401) {
        const disconnected = await disconnectCurrentConnection(ctx, event, "permission_revoked");
        await finish(ctx, event, disconnected ? "processed" : "ignored");
        return;
      }
      if (confirmation.response.status === 429 || confirmation.response.status >= 500) {
        await retry(
          ctx,
          event,
          responseRetryAfterMs(confirmation.response, TRANSIENT_RETRY_MS),
          confirmation.response.status !== 429,
        );
        return;
      }
      await finish(ctx, event, "ignored");
    } else {
      await finish(ctx, event, "ignored");
    }
    return;
  }
  if (event.aspectType === "delete") {
    await deleteActivity(ctx, event);
    await finish(ctx, event, "processed");
    return;
  }

  const fetched = await requestStravaApi(ctx, {
    identity: { userId: event.userId, generation: event.connectionGeneration },
    url: new URL(`${STRAVA_API_BASE_URL}/activities/${event.objectId}`),
  });
  if (!fetched.success) {
    if (fetched.retryable) {
      await retry(
        ctx,
        event,
        fetched.retryAfterMs ?? TRANSIENT_RETRY_MS,
        fetched.retryAfterMs === undefined,
      );
      return;
    }
    if (fetched.kind === "authorization_invalid") {
      await disconnectCurrentConnection(ctx, event, "token_invalid");
      await finish(ctx, event, "processed");
      return;
    }
    await finish(
      ctx,
      event,
      fetched.kind === "connection_changed" ? "ignored" : "error",
      fetched.kind === "connection_changed" ? undefined : "Strava authorization failed",
    );
    return;
  }
  if (fetched.response.status === 404) {
    await deleteActivity(ctx, event);
    await finish(ctx, event, "processed");
    return;
  }
  if (fetched.response.status === 401) {
    await disconnectCurrentConnection(ctx, event, "token_invalid");
    await finish(ctx, event, "processed");
    return;
  }
  if (fetched.response.status === 403) {
    await deleteActivity(ctx, event);
    await finish(ctx, event, "processed");
    return;
  }
  if (fetched.response.status === 429 || fetched.response.status >= 500) {
    await retry(
      ctx,
      event,
      responseRetryAfterMs(fetched.response, TRANSIENT_RETRY_MS),
      fetched.response.status !== 429,
    );
    return;
  }
  if (!fetched.response.ok) {
    await finish(ctx, event, "error", "Strava activity request rejected");
    return;
  }
  let activity;
  try {
    activity = parsePublicStravaActivity(await fetched.response.json());
  } catch {
    await finish(ctx, event, "error", "Invalid Strava activity response");
    return;
  }
  if (!activity) {
    await deleteActivity(ctx, event);
    await finish(ctx, event, "processed");
    return;
  }
  if (activity.athleteId !== event.ownerId || activity.providerActivityId !== event.objectId) {
    await finish(ctx, event, "error", "Strava activity ownership mismatch");
    return;
  }
  const persisted = await ctx.runMutation(internal.strava.activityPersistence.upsertActivity, {
    userId: event.userId,
    athleteId: event.ownerId,
    generation: event.connectionGeneration,
    activity,
    now: Date.now(),
  });
  await finish(ctx, event, persisted === "upserted" ? "processed" : "ignored");
}

export const processEvent = internalAction({
  args: { eventId: v.id("stravaWebhookEvents") },
  handler: async (ctx, { eventId }) => processEventHandler(ctx, eventId),
});
