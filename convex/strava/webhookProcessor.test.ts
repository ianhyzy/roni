/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { encryptStravaSecret, STRAVA_TOKEN_URL } from "./config";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../strava/${key.slice(2)}` : key] = value;
}

const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const originalEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
const originalClientId = process.env.STRAVA_CLIENT_ID;
const originalClientSecret = process.env.STRAVA_CLIENT_SECRET;
const originalCallbackUrl = process.env.STRAVA_OAUTH_CALLBACK_URL;

async function connect(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
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
  overrides: Record<string, unknown> = {},
): Promise<Id<"stravaWebhookEvents">> {
  return t.run((ctx) =>
    ctx.db.insert("stravaWebhookEvents", {
      eventKey: `98765:activity:update:123:42:${Math.floor(NOW / 1_000)}`,
      subscriptionId: "98765",
      objectType: "activity",
      aspectType: "update",
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

function responseHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "X-RateLimit-Limit": "200,2000",
    "X-RateLimit-Usage": "1,1",
    "X-ReadRateLimit-Limit": "100,1000",
    "X-ReadRateLimit-Usage": "1,1",
    ...extra,
  });
}

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
  process.env.STRAVA_CLIENT_ID = "client-id";
  process.env.STRAVA_CLIENT_SECRET = "client-secret";
  process.env.STRAVA_OAUTH_CALLBACK_URL = "https://app.test/strava/callback";
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
  if (originalClientId === undefined) delete process.env.STRAVA_CLIENT_ID;
  else process.env.STRAVA_CLIENT_ID = originalClientId;
  if (originalClientSecret === undefined) delete process.env.STRAVA_CLIENT_SECRET;
  else process.env.STRAVA_CLIENT_SECRET = originalClientSecret;
  if (originalCallbackUrl === undefined) delete process.env.STRAVA_OAUTH_CALLBACK_URL;
  else process.env.STRAVA_OAUTH_CALLBACK_URL = originalCallbackUrl;
});

describe("Strava webhook processor decisions", () => {
  it("disconnects only after current athlete authorization fails", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId, {
      eventKey: `98765:athlete:update:42:42:${Math.floor(NOW / 1_000)}`,
      objectType: "athlete",
      objectId: "42",
      updates: { authorized: "false" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401, headers: responseHeaders() }),
    );

    await t.action(internal.strava.webhookProcessor.processEvent, { eventId });

    const rows = await t.run(async (ctx) => ({
      event: await ctx.db.get(eventId),
      connection: await ctx.db.query("stravaConnections").unique(),
    }));
    expect(rows.event).toMatchObject({ status: "processed" });
    expect(rows.connection).toMatchObject({
      status: "disconnected",
      disconnectReason: "permission_revoked",
    });
  });

  it("keeps the connection when token refresh returns an invalid payload", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId, {
      eventKey: `98765:athlete:update:42:42:${Math.floor(NOW / 1_000)}`,
      objectType: "athlete",
      objectId: "42",
      updates: { authorized: "false" },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input) === STRAVA_TOKEN_URL
        ? new Response(JSON.stringify({ unexpected: true }), { status: 200 })
        : new Response(null, { status: 401, headers: responseHeaders() }),
    );

    await t.action(internal.strava.webhookProcessor.processEvent, { eventId });

    const rows = await t.run(async (ctx) => ({
      event: await ctx.db.get(eventId),
      connection: await ctx.db.query("stravaConnections").unique(),
    }));
    expect(rows.event).toMatchObject({
      status: "error",
      errorReason: "Strava authorization confirmation failed",
    });
    expect(rows.connection).toMatchObject({ status: "active" });
  });

  it("removes an inaccessible activity without disconnecting", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId);
    await t.run((ctx) =>
      ctx.db.insert("externalActivities", {
        userId,
        externalId: "strava:123",
        workoutType: "TrailRun",
        beginTime: "2026-07-29T12:00:00.000Z",
        totalDuration: 1_800,
        source: "strava",
        stravaConnectionGeneration: "generation-1",
        syncedAt: NOW - 1_000,
      }),
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 403, headers: responseHeaders() }),
    );

    await t.action(internal.strava.webhookProcessor.processEvent, { eventId });

    const rows = await t.run(async (ctx) => ({
      event: await ctx.db.get(eventId),
      connection: await ctx.db.query("stravaConnections").unique(),
      activity: await ctx.db.query("externalActivities").unique(),
    }));
    expect(rows.event).toMatchObject({ status: "processed" });
    expect(rows.connection).toMatchObject({ status: "active" });
    expect(rows.activity).toBeNull();
  });

  it("persists a valid activity update and completes the event", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(activityResponse()), {
        status: 200,
        headers: responseHeaders(),
      }),
    );

    await t.action(internal.strava.webhookProcessor.processEvent, { eventId });

    const rows = await t.run(async (ctx) => ({
      event: await ctx.db.get(eventId),
      activity: await ctx.db.query("externalActivities").unique(),
    }));
    expect(rows.event).toMatchObject({ status: "processed" });
    expect(rows.event).not.toHaveProperty("errorReason");
    expect(rows.activity).toMatchObject({
      userId,
      externalId: "strava:123",
      workoutType: "TrailRun",
      beginTime: "2026-07-29T12:00:00.000Z",
      totalDuration: 1_800,
      source: "strava",
      distance: 5_000,
      elevationGainMeters: 100,
      avgPaceSecondsPerKm: 300,
      stravaConnectionGeneration: "generation-1",
      syncedAt: NOW,
    });
  });

  it("propagates Retry-After without consuming a provider failure", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId, { providerFailures: 0 });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: responseHeaders({ "Retry-After": "7200" }),
      }),
    );

    await t.action(internal.strava.webhookProcessor.processEvent, { eventId });

    const event = await t.run((ctx) => ctx.db.get(eventId));
    expect(event).toMatchObject({
      status: "received",
      attempts: 1,
      providerFailures: 0,
      nextAttemptAt: NOW + 7_200_000,
    });
  });

  it("marks malformed activity JSON as a terminal event error", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json", { status: 200, headers: responseHeaders() }),
    );

    await t.action(internal.strava.webhookProcessor.processEvent, { eventId });

    const event = await t.run((ctx) => ctx.db.get(eventId));
    expect(event).toMatchObject({
      status: "error",
      errorReason: "Invalid Strava activity response",
    });
  });

  it("propagates persistence failures instead of mislabeling the payload", async () => {
    const t = convexTest(schema, modules);
    const userId = await connect(t);
    const eventId = await insertEvent(t, userId);
    await t.run(async (ctx) => {
      const row = {
        userId,
        externalId: "strava:123",
        workoutType: "TrailRun",
        beginTime: "2026-07-29T12:00:00.000Z",
        totalDuration: 1_800,
        source: "strava",
        stravaConnectionGeneration: "generation-1",
        syncedAt: NOW - 1_000,
      };
      await ctx.db.insert("externalActivities", row);
      await ctx.db.insert("externalActivities", row);
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(activityResponse()), {
        status: 200,
        headers: responseHeaders(),
      }),
    );

    await expect(
      t.action(internal.strava.webhookProcessor.processEvent, { eventId }),
    ).rejects.toThrow("Duplicate Strava activity rows");

    const event = await t.run((ctx) => ctx.db.get(eventId));
    expect(event).toMatchObject({ status: "processing" });
    expect(event).not.toHaveProperty("errorReason");
  });
});
