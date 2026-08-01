/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { hashOAuthArtifact } from "./strava/oauthFlow";

const modules = import.meta.glob("./**/*.*s");
const originalEnv = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  callbackUrl: process.env.STRAVA_OAUTH_CALLBACK_URL,
  postRedirectUrl: process.env.STRAVA_OAUTH_POST_REDIRECT_URL,
  webhookVerifyToken: process.env.STRAVA_WEBHOOK_VERIFY_TOKEN,
  webhookSubscriptionId: process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID,
  webhookSigningSecret: process.env.STRAVA_WEBHOOK_SIGNING_SECRET,
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function signatureHeader(
  body: string,
  secret = "webhook-signing-secret-123",
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1_000);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`)),
  );
  const hex = Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `t=${timestamp},v1=${hex}`;
}

describe("Strava OAuth HTTP callback", () => {
  beforeEach(() => {
    process.env.STRAVA_CLIENT_ID = "client-id";
    process.env.STRAVA_CLIENT_SECRET = "client-secret";
    process.env.STRAVA_OAUTH_CALLBACK_URL = "https://api.example.com/strava/oauth/callback";
    process.env.STRAVA_OAUTH_POST_REDIRECT_URL = "https://app.example.com/settings";
    process.env.STRAVA_WEBHOOK_VERIFY_TOKEN = "webhook-verify-token-123";
    process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID = "98765";
    process.env.STRAVA_WEBHOOK_SIGNING_SECRET = "webhook-signing-secret-123";
    process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
  });

  afterEach(() => {
    restoreEnv("STRAVA_CLIENT_ID", originalEnv.clientId);
    restoreEnv("STRAVA_CLIENT_SECRET", originalEnv.clientSecret);
    restoreEnv("STRAVA_OAUTH_CALLBACK_URL", originalEnv.callbackUrl);
    restoreEnv("STRAVA_OAUTH_POST_REDIRECT_URL", originalEnv.postRedirectUrl);
    restoreEnv("STRAVA_WEBHOOK_VERIFY_TOKEN", originalEnv.webhookVerifyToken);
    restoreEnv("STRAVA_WEBHOOK_SUBSCRIPTION_ID", originalEnv.webhookSubscriptionId);
    restoreEnv("STRAVA_WEBHOOK_SIGNING_SECRET", originalEnv.webhookSigningSecret);
    restoreEnv("TOKEN_ENCRYPTION_KEY", originalEnv.encryptionKey);
  });

  it("exchanges a valid callback for a one-time ticket without leaking code or state", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const state = "strava-state-value-123456";
    const authorizationCode = "strava-authorization-code-123456";
    await t.mutation(internal.strava.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: await hashOAuthArtifact(state),
      now: Date.now(),
    });

    const response = await t.fetch(
      `/strava/oauth/callback?code=${authorizationCode}&state=${state}&scope=read%2Cactivity%3Aread`,
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    expect(location).not.toBeNull();
    const redirect = new URL(location!);
    const ticket = redirect.searchParams.get("ticket");
    expect(redirect.origin + redirect.pathname).toBe("https://app.example.com/strava/callback");
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(location).not.toContain(authorizationCode);
    expect(location).not.toContain(state);

    const stored = await t.run(async (ctx) => ctx.db.query("stravaOauthCallbackTickets").unique());
    expect(stored).toMatchObject({ userId, acceptedScopes: ["activity:read"] });
    expect(stored?.ticketHash).toBe(await hashOAuthArtifact(ticket!));
    expect(stored?.authorizationCodeEncrypted).not.toContain(authorizationCode);
  });

  it("does not issue a ticket for a missing or replayed state", async () => {
    const t = convexTest(schema, modules);
    const state = "unknown-state-value-123456";
    const authorizationCode = "strava-authorization-code-123456";

    const response = await t.fetch(
      `/strava/oauth/callback?code=${authorizationCode}&state=${state}&scope=activity%3Aread`,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://app.example.com/settings?strava=error&reason=invalid_callback",
    );
    await expect(
      t.run(async (ctx) => ctx.db.query("stravaOauthCallbackTickets").take(1)),
    ).resolves.toEqual([]);
  });

  it("rejects private-only activity scope before creating a callback artifact", async () => {
    const t = convexTest(schema, modules);

    const response = await t.fetch(
      "/strava/oauth/callback?code=strava-authorization-code-123456&state=strava-state-value-123456&scope=activity%3Aread_all",
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://app.example.com/settings?strava=error&reason=missing_params",
    );
    await expect(
      t.run(async (ctx) => ctx.db.query("stravaOauthCallbackTickets").take(1)),
    ).resolves.toEqual([]);
  });

  it("verifies the webhook challenge without reflecting the verify token", async () => {
    const t = convexTest(schema, modules);
    const response = await t.fetch(
      "/strava/webhook?hub.mode=subscribe&hub.challenge=challenge-1&hub.verify_token=webhook-verify-token-123",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ "hub.challenge": "challenge-1" });

    const rejected = await t.fetch(
      "/strava/webhook?hub.mode=subscribe&hub.challenge=challenge-1&hub.verify_token=wrong-token",
    );
    expect(rejected.status).toBe(403);
    await expect(rejected.text()).resolves.not.toContain("webhook-verify-token-123");
  });

  it("ACKs and deduplicates a validated event only after resolving active ownership", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.mutation(internal.strava.connections.upsertActiveConnection, {
      userId,
      athleteId: "42",
      generation: "generation-1",
      accessTokenEncrypted: "access",
      refreshTokenEncrypted: "refresh",
      tokenExpiresAt: 10_000,
      scopes: ["activity:read"],
      refreshDueAt: 9_000,
      now: 1_000,
    });
    const body = JSON.stringify({
      subscription_id: 98765,
      object_type: "activity",
      aspect_type: "create",
      object_id: 123,
      owner_id: 42,
      event_time: 1_722_400_000,
      updates: {},
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await t.fetch("/strava/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Strava-Signature": await signatureHeader(body),
        },
        body,
      });
      expect(response.status).toBe(200);
    }

    const rows = await t.run(async (ctx) => ctx.db.query("stravaWebhookEvents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId,
      connectionGeneration: "generation-1",
      ownerId: "42",
      objectId: "123",
    });
  });

  it("ACKs an unknown athlete without retaining the payload", async () => {
    const t = convexTest(schema, modules);
    const body = JSON.stringify({
      subscription_id: 98765,
      object_type: "activity",
      aspect_type: "delete",
      object_id: 123,
      owner_id: 404,
      event_time: 1_722_400_000,
    });
    const response = await t.fetch("/strava/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Strava-Signature": await signatureHeader(body),
      },
      body,
    });
    expect(response.status).toBe(200);
    await expect(
      t.run(async (ctx) => ctx.db.query("stravaWebhookEvents").collect()),
    ).resolves.toEqual([]);
  });

  it("rejects the wrong subscription and malformed payloads", async () => {
    const t = convexTest(schema, modules);
    const wrongBody = JSON.stringify({
      subscription_id: 1,
      object_type: "activity",
      aspect_type: "create",
      object_id: 123,
      owner_id: 42,
      event_time: 1_722_400_000,
    });
    const wrongSubscription = await t.fetch("/strava/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Strava-Signature": await signatureHeader(wrongBody),
      },
      body: wrongBody,
    });
    expect(wrongSubscription.status).toBe(403);
    const malformedBody = JSON.stringify({
      subscription_id: 98765,
      token: "must-not-be-stored",
    });
    const malformed = await t.fetch("/strava/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Strava-Signature": await signatureHeader(malformedBody),
      },
      body: malformedBody,
    });
    expect(malformed.status).toBe(400);
  });

  it("rejects unsigned and tampered webhook deliveries before storage", async () => {
    const t = convexTest(schema, modules);
    const body = JSON.stringify({
      subscription_id: 98765,
      object_type: "athlete",
      aspect_type: "update",
      object_id: 42,
      owner_id: 42,
      event_time: 1_722_400_000,
      updates: { authorized: "false" },
    });
    const response = await t.fetch("/strava/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Strava-Signature": "t=1,v1=bad" },
      body,
    });
    expect(response.status).toBe(403);
    await expect(
      t.run(async (ctx) => ctx.db.query("stravaWebhookEvents").collect()),
    ).resolves.toEqual([]);
  });
});
