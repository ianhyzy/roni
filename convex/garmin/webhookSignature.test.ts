import { afterEach, describe, expect, it, vi } from "vitest";
import http from "../http";
import { garminWebhookFailureStatus, verifyGarminWebhookSignature } from "./webhookSignature";

class TrackingRequest extends Request {
  bodyWasRead = false;

  private trackBodyRead(): void {
    this.bodyWasRead = true;
  }

  override get body() {
    this.trackBodyRead();
    return super.body;
  }

  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.trackBodyRead();
    return await super.arrayBuffer();
  }

  override async blob(): Promise<Blob> {
    this.trackBodyRead();
    return await super.blob();
  }

  override clone(): Request {
    this.trackBodyRead();
    return super.clone();
  }

  override async formData(): Promise<FormData> {
    this.trackBodyRead();
    return await super.formData();
  }

  override async json(): Promise<unknown> {
    this.trackBodyRead();
    return await super.json();
  }

  override async text(): Promise<string> {
    this.trackBodyRead();
    return await super.text();
  }
}

async function runGarminRoute(req: Request, ctx: object = {}): Promise<Response> {
  const route = http.lookup(new URL(req.url).pathname, "POST");
  if (!route) throw new Error("Expected Garmin path-secret route");
  const handler = route[0] as unknown as {
    _handler: (ctx: object, request: Request) => Promise<Response>;
  };
  return await handler._handler(ctx, req);
}

describe("Garmin path-secret webhook routes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers a path-secret route for a supported event type", () => {
    const pathSecretRoute = http.lookup("/garmin/webhook/activities/secret-1", "POST");

    expect(pathSecretRoute).not.toBeNull();
  });

  it("processes an authenticated path-secret delivery through the registered handler", async () => {
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret-1");
    const store = vi.fn().mockResolvedValue("storage-1");
    const runMutation = vi.fn().mockResolvedValue("event-1");
    const runAfter = vi.fn().mockResolvedValue(undefined);
    const req = new Request("https://example.com/garmin/webhook/activities/secret-1", {
      method: "POST",
      body: '{"activities":[]}',
    });

    const response = await runGarminRoute(req, {
      storage: { store },
      runMutation,
      scheduler: { runAfter },
    });

    expect(response.status).toBe(200);
    expect(store).toHaveBeenCalledOnce();
    expect(runMutation).toHaveBeenCalledWith(expect.anything(), {
      eventType: "activities",
      rawPayloadStorageId: "storage-1",
    });
    expect(runAfter).toHaveBeenCalledWith(0, expect.anything(), {
      eventId: "event-1",
      eventType: "activities",
      rawPayloadStorageId: "storage-1",
    });
  });

  it("does not route path-secret requests for unsupported event types", () => {
    const req = new TrackingRequest("https://example.com/garmin/webhook/notSupported/secret-1", {
      method: "POST",
      body: "{}",
    });

    const route = http.lookup(new URL(req.url).pathname, "POST");

    expect(route).toBeNull();
    expect(req.bodyWasRead).toBe(false);
  });

  it("rejects malformed paths before reading the request body", async () => {
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret-1");
    const req = new TrackingRequest(
      "https://example.com/garmin/webhook/activities/extra/secret-1",
      { method: "POST", body: "{}" },
    );

    const response = await runGarminRoute(req);

    expect(response.status).toBe(404);
    expect(req.bodyWasRead).toBe(false);
  });

  it("rejects malformed percent-encoding before reading the request body", async () => {
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret-1");
    const req = new TrackingRequest("https://example.com/garmin/webhook/activities/%ZZ", {
      method: "POST",
      body: "{}",
    });

    const response = await runGarminRoute(req);

    expect(response.status).toBe(404);
    expect(req.bodyWasRead).toBe(false);
  });
});

describe("verifyGarminWebhookSignature", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a non-empty body with the configured query secret", async () => {
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret-1");
    const req = new Request("https://example.com/garmin/webhook/activities?secret=secret-1");

    await expect(verifyGarminWebhookSignature(req, "{}")).resolves.toEqual({ valid: true });
  });

  it("accepts the configured secret as the final path segment", async () => {
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret-1");
    const req = new Request("https://example.com/garmin/webhook/activities/secret-1");

    await expect(verifyGarminWebhookSignature(req, "{}")).resolves.toEqual({ valid: true });
  });

  it("decodes the path secret before comparing it", async () => {
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret/1");
    const req = new Request("https://example.com/garmin/webhook/activities/secret%2F1");

    await expect(verifyGarminWebhookSignature(req, "{}")).resolves.toEqual({ valid: true });
  });

  it("rejects a valid secret when the path contains an extra segment", async () => {
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret-1");
    const req = new Request("https://example.com/garmin/webhook/activities/extra/secret-1");

    await expect(verifyGarminWebhookSignature(req, "{}")).resolves.toEqual({
      valid: false,
      reason: "Invalid Garmin webhook secret",
    });
  });

  it("rejects a valid secret on an unsupported event path", async () => {
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret-1");
    const req = new Request("https://example.com/garmin/webhook/notSupported/secret-1");

    await expect(verifyGarminWebhookSignature(req, "{}")).resolves.toEqual({
      valid: false,
      reason: "Invalid Garmin webhook secret",
    });
  });

  it("accepts the configured header secret for manual replay tools", async () => {
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret-1");
    const req = new Request("https://example.com/garmin/webhook/activities", {
      headers: { "x-roni-garmin-webhook-secret": "secret-1" },
    });

    await expect(verifyGarminWebhookSignature(req, "{}")).resolves.toEqual({ valid: true });
  });

  it("trims the configured secret before comparing", async () => {
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", " secret-1 ");
    const req = new Request("https://example.com/garmin/webhook/activities?secret=secret-1");

    await expect(verifyGarminWebhookSignature(req, "{}")).resolves.toEqual({ valid: true });
  });

  it("rejects when GARMIN_WEBHOOK_SECRET is unset", async () => {
    const req = new Request("https://example.com/garmin/webhook/activities");
    await expect(verifyGarminWebhookSignature(req, "{}")).resolves.toEqual({
      valid: false,
      reason: "Garmin webhook secret is not configured",
    });
  });

  it("rejects a wrong path secret even when the query secret matches", async () => {
    const req = new Request("https://example.com/garmin/webhook/activities/wrong?secret=secret-1");
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret-1");
    await expect(verifyGarminWebhookSignature(req, "{}")).resolves.toEqual({
      valid: false,
      reason: "Invalid Garmin webhook secret",
    });
  });

  it("allows unsigned dev webhooks only when explicitly enabled and no secret is configured", async () => {
    vi.stubEnv("GARMIN_ALLOW_UNAUTHENTICATED_WEBHOOKS", "true");
    const req = new Request("https://example.com/garmin/webhook/activities");

    await expect(verifyGarminWebhookSignature(req, "{}")).resolves.toEqual({ valid: true });

    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret-1");
    await expect(verifyGarminWebhookSignature(req, "{}")).resolves.toEqual({
      valid: false,
      reason: "Invalid Garmin webhook secret",
    });
  });

  it("rejects empty bodies before checking the secret", async () => {
    vi.stubEnv("GARMIN_WEBHOOK_SECRET", "secret-1");
    const req = new Request("https://example.com/garmin/webhook/activities?secret=secret-1");

    await expect(verifyGarminWebhookSignature(req, "")).resolves.toEqual({
      valid: false,
      reason: "Empty Garmin webhook body",
    });
  });

  it("maps malformed empty requests to bad request and auth failures to unauthorized", () => {
    expect(garminWebhookFailureStatus("Empty Garmin webhook body")).toBe(400);
    expect(garminWebhookFailureStatus("Garmin webhook secret is not configured")).toBe(500);
    expect(garminWebhookFailureStatus("Invalid Garmin webhook secret")).toBe(401);
  });
});
