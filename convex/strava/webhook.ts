import { v } from "convex/values";
import { z } from "zod";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery } from "../_generated/server";
import { isDeletionInProgress } from "../lib/auth";
import {
  STRAVA_WEBHOOK_PROCESSING_LEASE_MS,
  STRAVA_WEBHOOK_RECOVERY_GRACE_MS,
  STRAVA_WEBHOOK_RETENTION_MS,
} from "./webhookTiming";

const updatesSchema = z
  .object({
    title: z.string().optional(),
    type: z.string().optional(),
    private: z.string().optional(),
    authorized: z.string().optional(),
  })
  .strict();

const webhookEnvelopeSchema = z
  .object({
    subscription_id: z.number().int().nonnegative().safe(),
    object_type: z.enum(["activity", "athlete"]),
    aspect_type: z.enum(["create", "update", "delete"]),
    object_id: z.number().int().nonnegative().safe(),
    owner_id: z.number().int().nonnegative().safe(),
    event_time: z.number().int().nonnegative().safe(),
    updates: updatesSchema.optional(),
  })
  .strict();

const updatesValidator = v.object({
  title: v.optional(v.string()),
  type: v.optional(v.string()),
  private: v.optional(v.string()),
  authorized: v.optional(v.string()),
});

export interface StravaWebhookEnvelope {
  subscriptionId: string;
  objectType: "activity" | "athlete";
  aspectType: "create" | "update" | "delete";
  objectId: string;
  ownerId: string;
  eventTime: number;
  updates?: {
    title?: string;
    type?: string;
    private?: string;
    authorized?: string;
  };
}

export function parseStravaWebhookEnvelope(raw: unknown): StravaWebhookEnvelope {
  const parsed = webhookEnvelopeSchema.parse(raw);
  return {
    subscriptionId: String(parsed.subscription_id),
    objectType: parsed.object_type,
    aspectType: parsed.aspect_type,
    objectId: String(parsed.object_id),
    ownerId: String(parsed.owner_id),
    eventTime: parsed.event_time,
    updates: parsed.updates,
  };
}

function eventKey(event: StravaWebhookEnvelope): string {
  return [
    event.subscriptionId,
    event.objectType,
    event.aspectType,
    event.objectId,
    event.ownerId,
    event.eventTime,
    JSON.stringify([
      event.updates?.title ?? null,
      event.updates?.type ?? null,
      event.updates?.private ?? null,
      event.updates?.authorized ?? null,
    ]),
  ].join(":");
}

function processingNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export const resolveActiveOwner = internalQuery({
  args: { athleteId: v.string() },
  returns: v.union(v.null(), v.object({ userId: v.id("users"), generation: v.string() })),
  handler: async (ctx, { athleteId }) => {
    const rows = await ctx.db
      .query("stravaConnections")
      .withIndex("by_athleteId_and_status", (q) =>
        q.eq("athleteId", athleteId).eq("status", "active"),
      )
      .take(2);
    if (rows.length > 1) throw new Error("Ambiguous Strava athlete ownership");
    const row = rows[0];
    return row ? { userId: row.userId, generation: row.generation } : null;
  },
});

export const recordReceived = internalMutation({
  args: {
    event: v.object({
      subscriptionId: v.string(),
      objectType: v.union(v.literal("activity"), v.literal("athlete")),
      aspectType: v.union(v.literal("create"), v.literal("update"), v.literal("delete")),
      objectId: v.string(),
      ownerId: v.string(),
      eventTime: v.number(),
      updates: v.optional(updatesValidator),
    }),
    userId: v.id("users"),
    connectionGeneration: v.string(),
    now: v.number(),
  },
  returns: v.union(v.literal("recorded"), v.literal("duplicate"), v.literal("ignored")),
  handler: async (ctx, args) => {
    if (await isDeletionInProgress(ctx, args.userId)) return "ignored";
    const owner = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (
      !owner ||
      owner.status !== "active" ||
      owner.athleteId !== args.event.ownerId ||
      owner.generation !== args.connectionGeneration ||
      args.event.eventTime * 1_000 + 999 < owner.connectedAt
    ) {
      return "ignored";
    }
    const key = eventKey(args.event);
    const existing = await ctx.db
      .query("stravaWebhookEvents")
      .withIndex("by_eventKey", (q) => q.eq("eventKey", key))
      .take(2);
    if (existing.length > 1) throw new Error("Duplicate Strava webhook receipts");
    if (existing.length === 1) return "duplicate";
    const eventId = await ctx.db.insert("stravaWebhookEvents", {
      eventKey: key,
      ...args.event,
      userId: args.userId,
      connectionGeneration: args.connectionGeneration,
      status: "received",
      attempts: 0,
      dispatchAttempts: 1,
      providerFailures: 0,
      receivedAt: args.now,
      updatedAt: args.now,
    });
    await ctx.scheduler.runAfter(0, internal.strava.webhookProcessor.processEvent, { eventId });
    await ctx.scheduler.runAfter(
      STRAVA_WEBHOOK_PROCESSING_LEASE_MS + STRAVA_WEBHOOK_RECOVERY_GRACE_MS,
      internal.strava.webhookRecovery.recoverEvent,
      { eventId },
    );
    await ctx.scheduler.runAfter(
      STRAVA_WEBHOOK_RETENTION_MS,
      internal.strava.webhookRecovery.cleanupEvent,
      {
        eventId,
        cutoff: args.now,
      },
    );
    return "recorded";
  },
});

const claimedEventValidator = v.object({
  eventId: v.id("stravaWebhookEvents"),
  userId: v.id("users"),
  connectionGeneration: v.string(),
  objectType: v.union(v.literal("activity"), v.literal("athlete")),
  aspectType: v.union(v.literal("create"), v.literal("update"), v.literal("delete")),
  objectId: v.string(),
  ownerId: v.string(),
  updates: v.optional(updatesValidator),
  attempts: v.number(),
  processingNonce: v.string(),
});

export type ClaimedStravaWebhookEvent = typeof claimedEventValidator.type;

export const claimEvent = internalMutation({
  args: { eventId: v.id("stravaWebhookEvents"), now: v.number() },
  returns: v.union(v.null(), claimedEventValidator),
  handler: async (ctx, { eventId, now }) => {
    const event = await ctx.db.get(eventId);
    if (!event || event.status === "processed" || event.status === "ignored") return null;
    if (event.status === "error") return null;
    if (event.nextAttemptAt && event.nextAttemptAt > now) return null;
    if (
      event.status === "processing" &&
      event.updatedAt + STRAVA_WEBHOOK_PROCESSING_LEASE_MS > now
    ) {
      return null;
    }
    const owner = await ctx.db
      .query("stravaConnections")
      .withIndex("by_userId", (q) => q.eq("userId", event.userId))
      .unique();
    if (
      !owner ||
      owner.status !== "active" ||
      owner.athleteId !== event.ownerId ||
      owner.generation !== event.connectionGeneration ||
      event.eventTime * 1_000 + 999 < owner.connectedAt
    ) {
      await ctx.db.patch(eventId, { status: "ignored", updatedAt: now });
      return null;
    }
    const attempts = event.attempts + 1;
    const nonce = processingNonce();
    await ctx.db.patch(eventId, {
      status: "processing",
      attempts,
      processingNonce: nonce,
      nextAttemptAt: undefined,
      updatedAt: now,
    });
    return {
      eventId,
      userId: event.userId,
      connectionGeneration: event.connectionGeneration,
      objectType: event.objectType,
      aspectType: event.aspectType,
      objectId: event.objectId,
      ownerId: event.ownerId,
      updates: event.updates,
      attempts,
      processingNonce: nonce,
    };
  },
});

export const finishEvent = internalMutation({
  args: {
    eventId: v.id("stravaWebhookEvents"),
    status: v.union(v.literal("processed"), v.literal("ignored"), v.literal("error")),
    processingNonce: v.string(),
    errorReason: v.optional(v.string()),
    now: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId);
    if (!event || event.status !== "processing" || event.processingNonce !== args.processingNonce) {
      return false;
    }
    await ctx.db.patch(args.eventId, {
      status: args.status,
      errorReason: args.errorReason,
      processingNonce: undefined,
      updatedAt: args.now,
    });
    return true;
  },
});
