/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { encryptStravaSecret } from "./config";
import { parseStravaWebhookEnvelope } from "./webhook";
import { verifyStravaWebhookToken } from "./webhookSignature";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../strava/${key.slice(2)}` : key] = value;
}

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const originalEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;

async function connect(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
  await t.mutation(internal.strava.connections.upsertActiveConnection, {
    userId,
    athleteId: "42",
    generation: "generation-1",
    accessTokenEncrypted: await encryptStravaSecret("access-token"),
    refreshTokenEncrypted: await encryptStravaSecret("refresh-token"),
    tokenExpiresAt: NOW + 60 * 60 * 1_000,
    scopes: ["activity:read"],
    refreshDueAt: NOW + 30 * 60 * 1_000,
    now: NOW - 1_000,
  });
  return userId;
}

async function insertEvent(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("stravaWebhookEvents", {
      eventKey: `98765:activity:create:123:42:${Math.floor(NOW / 1_000)}`,
      subscriptionId: "98765",
      objectType: "activity",
      aspectType: "create",
      objectId: "123",
      ownerId: "42",
      eventTime: Math.floor(NOW / 1_000),
      userId,
      connectionGeneration: "generation-1",
      status: "received",
      attempts: 0,
      receivedAt: NOW,
      updatedAt: NOW,
      ...overrides,
    }),
  );
}

function activityResponse() {
  return {
    id: 123,
    athlete: { id: 42 },
    name: "Morning run",
    type: "Run",
    sport_type: "TrailRun",
    start_date: "2026-07-29T12:00:00.000Z",
    start_date_local: "2026-07-29T06:00:00.000Z",
    timezone: "(GMT-07:00) America/Denver",
    distance: 5_000,
    moving_time: 1_500,
    elapsed_time: 1_800,
    total_elevation_gain: 100,
    achievement_count: 1,
    trainer: false,
    commute: false,
    manual: false,
    private: false,
  };
}

function responseHeaders(): Headers {
  return new Headers({
    "X-RateLimit-Limit": "200,2000",
    "X-RateLimit-Usage": "1,1",
    "X-ReadRateLimit-Limit": "100,1000",
    "X-ReadRateLimit-Usage": "1,1",
  });
}

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
});

describe("Strava webhook boundary", () => {
  it("strictly parses known fields and compares verify tokens without echoing them", async () => {
    expect(
      parseStravaWebhookEnvelope({
        subscription_id: 98765,
        object_type: "athlete",
        aspect_type: "update",
        object_id: 42,
        owner_id: 42,
        event_time: 1_722_400_000,
        updates: { authorized: "false" },
      }),
    ).toMatchObject({ subscriptionId: "98765", ownerId: "42" });
    expect(() =>
      parseStravaWebhookEnvelope({
        subscription_id: 98765,
        object_type: "activity",
        aspect_type: "create",
        object_id: 123,
        owner_id: 42,
        event_time: 1_722_400_000,
        access_token: "must-be-rejected",
      }),
    ).toThrow();
    await expect(verifyStravaWebhookToken("secret-123", "secret-123")).resolves.toBe(true);
    await expect(verifyStravaWebhookToken("wrong", "secret-123")).resolves.toBe(false);
  });

  it("deduplicates identical receipts and retains distinct same-second updates", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const event = {
      subscriptionId: "98765",
      objectType: "activity" as const,
      aspectType: "create" as const,
      objectId: "123",
      ownerId: "42",
      eventTime: Math.floor(NOW / 1_000),
      updates: {},
    };
    const args = { event, userId, connectionGeneration: "generation-1", now: NOW };
    await expect(t.mutation(internal.strava.webhook.recordReceived, args)).resolves.toBe(
      "recorded",
    );
    await expect(t.mutation(internal.strava.webhook.recordReceived, args)).resolves.toBe(
      "duplicate",
    );
    await expect(
      t.mutation(internal.strava.webhook.recordReceived, {
        ...args,
        event: { ...event, updates: { title: "Renamed activity" } },
      }),
    ).resolves.toBe("recorded");
    await expect(
      t.mutation(internal.strava.webhook.recordReceived, {
        ...args,
        event: { ...event, eventTime: event.eventTime + 1 },
        connectionGeneration: "stale",
      }),
    ).resolves.toBe("ignored");
    await expect(
      t.run(async (ctx) => ctx.db.query("stravaWebhookEvents").collect()),
    ).resolves.toHaveLength(2);
  });

  it("rejects a delayed event that predates the current connection", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    await expect(
      t.mutation(internal.strava.webhook.recordReceived, {
        event: {
          subscriptionId: "98765",
          objectType: "athlete",
          aspectType: "update",
          objectId: "42",
          ownerId: "42",
          eventTime: Math.floor((NOW - 2_000) / 1_000),
          updates: { authorized: "false" },
        },
        userId,
        connectionGeneration: "generation-1",
        now: NOW,
      }),
    ).resolves.toBe("ignored");
    await expect(
      t.run(async (ctx) => ctx.db.query("stravaWebhookEvents").collect()),
    ).resolves.toEqual([]);
  });

  it("fences stale processors and recovers an expired processing lease", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId, { dispatchAttempts: 1 });
    const claimed = await t.mutation(internal.strava.webhook.claimEvent, {
      eventId,
      now: NOW,
    });
    expect(claimed).not.toBeNull();
    await expect(
      t.mutation(internal.strava.webhook.finishEvent, {
        eventId,
        status: "processed",
        processingNonce: "stale-nonce",
        now: NOW + 1,
      }),
    ).resolves.toBe(false);

    vi.setSystemTime(NOW + 2 * 60 * 1_000 + 5_000);
    await expect(
      t.mutation(internal.strava.webhookRecovery.recoverEvent, { eventId }),
    ).resolves.toBe(true);
    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event).toMatchObject({ status: "received", dispatchAttempts: 2 });
    expect(event).not.toHaveProperty("processingNonce");
  });

  it("honors long budget deferrals without counting a provider failure", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId, { dispatchAttempts: 1, providerFailures: 0 });
    const claimed = await t.mutation(internal.strava.webhook.claimEvent, {
      eventId,
      now: NOW,
    });
    if (!claimed) throw new Error("Expected claimed event");
    const delayMs = 6 * 60 * 60 * 1_000;

    await expect(
      t.mutation(internal.strava.webhookRecovery.retryEvent, {
        eventId,
        attempts: claimed.attempts,
        processingNonce: claimed.processingNonce,
        delayMs,
        countProviderFailure: false,
        now: NOW,
      }),
    ).resolves.toBe(true);
    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event).toMatchObject({
      status: "received",
      providerFailures: 0,
      dispatchAttempts: 2,
      nextAttemptAt: NOW + delayMs,
    });
  });

  it("fetches, validates, and persists an activity create event", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify(activityResponse()), { headers: responseHeaders() }),
      );

    await t.action(internal.strava.webhookProcessor.processEvent, { eventId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api-v3.strava.com/activities/123");
    const rows = await t.run(async (ctx) => ({
      event: await ctx.db.get(eventId),
      activity: await ctx.db.query("externalActivities").unique(),
    }));
    expect(rows.event).toMatchObject({ status: "processed", attempts: 1 });
    expect(rows.activity).toMatchObject({
      externalId: "strava:123",
      source: "strava",
      stravaConnectionGeneration: "generation-1",
    });
  });

  it("retries transient activity fetch failures without flattening the receipt", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503, headers: responseHeaders() }),
    );

    await t.action(internal.strava.webhookProcessor.processEvent, { eventId });

    const event = await t.run(async (ctx) => ctx.db.get(eventId));
    expect(event).toMatchObject({ status: "received", attempts: 1 });
    expect(event).not.toHaveProperty("errorReason");
  });

  it("keeps the current connection when deauthorization confirmation succeeds", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId, {
      eventKey: `98765:athlete:update:42:42:${Math.floor(NOW / 1_000)}`,
      objectType: "athlete",
      aspectType: "update",
      objectId: "42",
      updates: { authorized: "false" },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: 42 }), { headers: responseHeaders() }));

    await t.action(internal.strava.webhookProcessor.processEvent, { eventId });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rows = await t.run(async (ctx) => ({
      event: await ctx.db.get(eventId),
      connection: await ctx.db.query("stravaConnections").unique(),
    }));
    expect(rows.event).toMatchObject({ status: "ignored" });
    expect(rows.connection).toMatchObject({
      status: "active",
      generation: "generation-1",
    });
  });
});
