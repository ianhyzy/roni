import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import {
  STRAVA_WEBHOOK_PROCESSING_LEASE_MS,
  STRAVA_WEBHOOK_RECOVERY_GRACE_MS,
} from "./webhookTiming";

const MAX_PROVIDER_FAILURES = 3;
const MAX_DISPATCH_ATTEMPTS = 20;
const RETRY_BASE_MS = 30_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;

export const retryEvent = internalMutation({
  args: {
    eventId: v.id("stravaWebhookEvents"),
    attempts: v.number(),
    processingNonce: v.string(),
    delayMs: v.number(),
    countProviderFailure: v.boolean(),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (
      !event ||
      event.status !== "processing" ||
      event.attempts !== args.attempts ||
      event.processingNonce !== args.processingNonce
    ) {
      return false;
    }
    const providerFailures = (event.providerFailures ?? 0) + (args.countProviderFailure ? 1 : 0);
    if (providerFailures >= MAX_PROVIDER_FAILURES) {
      await ctx.db.patch(args.eventId, {
        status: "error",
        errorReason: "Strava webhook retries exhausted",
        providerFailures,
        processingNonce: undefined,
        updatedAt: args.now,
      });
      return false;
    }
    const delayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      Math.max(1_000, Number.isFinite(args.delayMs) ? args.delayMs : RETRY_BASE_MS),
    );
    const dispatchAttempts = (event.dispatchAttempts ?? 1) + 1;
    if (dispatchAttempts > MAX_DISPATCH_ATTEMPTS) {
      await ctx.db.patch(args.eventId, {
        status: "error",
        errorReason: "Strava webhook dispatch retries exhausted",
        providerFailures,
        processingNonce: undefined,
        updatedAt: args.now,
      });
      return false;
    }
    await ctx.db.patch(args.eventId, {
      status: "received",
      providerFailures,
      dispatchAttempts,
      processingNonce: undefined,
      nextAttemptAt: args.now + delayMs,
      updatedAt: args.now,
    });
    await ctx.scheduler.runAfter(delayMs, internal.strava.webhookProcessor.processEvent, {
      eventId: args.eventId,
    });
    return true;
  },
});

export const recoverEvent = internalMutation({
  args: { eventId: v.id("stravaWebhookEvents") },
  returns: v.boolean(),
  handler: async (ctx, { eventId }) => {
    const event = await ctx.db.get(eventId);
    if (!event || ["processed", "ignored", "error"].includes(event.status)) return false;
    const now = Date.now();
    const waitUntil = Math.max(
      event.nextAttemptAt ?? 0,
      event.status === "processing" ? event.updatedAt + STRAVA_WEBHOOK_PROCESSING_LEASE_MS : 0,
    );
    if (waitUntil > now) {
      await ctx.scheduler.runAfter(
        waitUntil - now + STRAVA_WEBHOOK_RECOVERY_GRACE_MS,
        internal.strava.webhookRecovery.recoverEvent,
        { eventId },
      );
      return true;
    }
    const dispatchAttempts = event.dispatchAttempts ?? 1;
    if (dispatchAttempts >= MAX_DISPATCH_ATTEMPTS) {
      await ctx.db.patch(eventId, {
        status: "error",
        errorReason: "Strava webhook dispatch retries exhausted",
        processingNonce: undefined,
        updatedAt: now,
      });
      return false;
    }
    await ctx.db.patch(eventId, {
      status: "received",
      dispatchAttempts: dispatchAttempts + 1,
      processingNonce: undefined,
      nextAttemptAt: undefined,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.strava.webhookProcessor.processEvent, { eventId });
    await ctx.scheduler.runAfter(
      STRAVA_WEBHOOK_PROCESSING_LEASE_MS + STRAVA_WEBHOOK_RECOVERY_GRACE_MS,
      internal.strava.webhookRecovery.recoverEvent,
      { eventId },
    );
    return true;
  },
});

export const cleanupEvent = internalMutation({
  args: { eventId: v.id("stravaWebhookEvents"), cutoff: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event || event.receivedAt > args.cutoff) return false;
    if (event.status === "received" || event.status === "processing") {
      await ctx.db.patch(args.eventId, {
        status: "error",
        errorReason: "Strava webhook retention expired",
        processingNonce: undefined,
        updatedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(0, internal.strava.webhookRecovery.cleanupEvent, args);
      return false;
    }
    await ctx.db.delete(args.eventId);
    return true;
  },
});
