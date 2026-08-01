import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptStravaSecret,
  encryptStravaSecret,
  getStravaAppConfig,
  getStravaWebhookConfig,
  isStravaConfigured,
  isStravaFeatureConfigured,
  STRAVA_REQUIRED_SCOPE,
  supportedStravaScopes,
} from "./config";

const originalEnv = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  callbackUrl: process.env.STRAVA_OAUTH_CALLBACK_URL,
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  webhookVerifyToken: process.env.STRAVA_WEBHOOK_VERIFY_TOKEN,
  webhookSubscriptionId: process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID,
  webhookSigningSecret: process.env.STRAVA_WEBHOOK_SIGNING_SECRET,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("Strava configuration", () => {
  beforeEach(() => {
    process.env.STRAVA_CLIENT_ID = "client-id";
    process.env.STRAVA_CLIENT_SECRET = "client-secret";
    process.env.STRAVA_OAUTH_CALLBACK_URL = "https://api.example.com/strava/oauth/callback";
    process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
    process.env.STRAVA_WEBHOOK_VERIFY_TOKEN = "webhook-verify-token-123";
    process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID = "98765";
    process.env.STRAVA_WEBHOOK_SIGNING_SECRET = "webhook-signing-secret-123";
  });

  afterEach(() => {
    restoreEnv("STRAVA_CLIENT_ID", originalEnv.clientId);
    restoreEnv("STRAVA_CLIENT_SECRET", originalEnv.clientSecret);
    restoreEnv("STRAVA_OAUTH_CALLBACK_URL", originalEnv.callbackUrl);
    restoreEnv("TOKEN_ENCRYPTION_KEY", originalEnv.encryptionKey);
    restoreEnv("STRAVA_WEBHOOK_VERIFY_TOKEN", originalEnv.webhookVerifyToken);
    restoreEnv("STRAVA_WEBHOOK_SUBSCRIPTION_ID", originalEnv.webhookSubscriptionId);
    restoreEnv("STRAVA_WEBHOOK_SIGNING_SECRET", originalEnv.webhookSigningSecret);
  });

  it("exposes the feature only when the webhook is fully configured", () => {
    expect(isStravaFeatureConfigured()).toBe(true);
    expect(getStravaWebhookConfig()).toEqual({
      verifyToken: "webhook-verify-token-123",
      subscriptionId: "98765",
      signingSecret: "webhook-signing-secret-123",
    });

    delete process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID;

    expect(isStravaConfigured()).toBe(true);
    expect(isStravaFeatureConfigured()).toBe(false);
    expect(() => getStravaWebhookConfig()).toThrow("Strava webhook is not configured");
  });

  it("requires all provider and encryption configuration", () => {
    expect(isStravaConfigured()).toBe(true);
    expect(getStravaAppConfig()).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://api.example.com/strava/oauth/callback",
    });

    delete process.env.STRAVA_CLIENT_SECRET;

    expect(isStravaConfigured()).toBe(false);
    expect(() => getStravaAppConfig()).toThrow("Strava is not configured");
  });

  it("keeps only the requested read scope", () => {
    expect(
      supportedStravaScopes(["read", "activity:read_all", STRAVA_REQUIRED_SCOPE, "activity:write"]),
    ).toEqual([STRAVA_REQUIRED_SCOPE]);
    expect(supportedStravaScopes(["read", "activity:read_all"])).toEqual([]);
  });

  it("encrypts provider secrets at rest", async () => {
    const encrypted = await encryptStravaSecret("strava-token");

    expect(encrypted).not.toContain("strava-token");
    await expect(decryptStravaSecret(encrypted)).resolves.toBe("strava-token");
  });

  it("fails closed when the shared encryption key is missing", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;

    await expect(encryptStravaSecret("strava-token")).rejects.toThrow(
      "TOKEN_ENCRYPTION_KEY env var is not set",
    );
  });
});
