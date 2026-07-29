import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  encryptFitbitSecret,
  FITBIT_READ_SCOPES,
  FITBIT_REVOKE_URL,
  FITBIT_TOKEN_URL,
  GOOGLE_HEALTH_API_BASE_URL,
} from "./config";
import {
  buildFitbitAuthorizeUrl,
  completeFitbitOAuth,
  type CompleteFitbitOAuthResult,
  hashOAuthState,
  parseIdentityResponse,
  parseInitialTokenResponse,
} from "./oauthFlow";

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;
type CompleteHandler = (
  ctx: ActionCtx,
  args: { ticket: string },
) => Promise<CompleteFitbitOAuthResult>;

const completeHandler = (completeFitbitOAuth as unknown as { _handler: CompleteHandler })._handler;

function localFunctionName(ref: TestFunctionReference): string | null {
  try {
    return getFunctionName(ref);
  } catch {
    return null;
  }
}

describe("Fitbit OAuth helpers", () => {
  it("builds the Google authorization request with offline consent", () => {
    const url = new URL(
      buildFitbitAuthorizeUrl(
        { clientId: "client-1", clientSecret: "secret", redirectUri: "https://app.test/cb" },
        "state-1",
      ),
    );

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(FITBIT_READ_SCOPES);
  });

  it("hashes OAuth state deterministically without returning the raw state", async () => {
    const first = await hashOAuthState("raw-state");
    const second = await hashOAuthState("raw-state");

    expect(first).toBe(second);
    expect(first).not.toContain("raw-state");
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("validates initial token and identity responses", () => {
    expect(
      parseInitialTokenResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: FITBIT_READ_SCOPES.join(" "),
      }),
    ).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresInSeconds: 3600,
      scopes: [...FITBIT_READ_SCOPES],
    });
    expect(parseIdentityResponse({ healthUserId: "health-1" })).toEqual({
      healthUserId: "health-1",
    });
  });

  it("rejects token responses without an offline refresh token", () => {
    expect(() =>
      parseInitialTokenResponse({
        access_token: "access",
        expires_in: 3600,
        token_type: "Bearer",
        scope: FITBIT_READ_SCOPES.join(" "),
      }),
    ).toThrow("Malformed Google OAuth token response");
  });

  it("accepts partial consent and keeps only supported read scopes", () => {
    expect(
      parseInitialTokenResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: `${FITBIT_READ_SCOPES[0]} openid email`,
      }).scopes,
    ).toEqual([FITBIT_READ_SCOPES[0]]);
  });

  it("rejects activation with zero supported read scopes", () => {
    expect(() =>
      parseInitialTokenResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "openid email",
      }),
    ).toThrow("Google OAuth did not grant a supported Fitbit read scope");
  });
});

describe("Fitbit OAuth completion token ownership", () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");
  const userId = "user-1" as Id<"users">;
  const ticket = "fitbit-callback-ticket-123";
  const refreshToken = "new-refresh-token";
  const originalEnv = {
    clientId: process.env.FITBIT_GOOGLE_CLIENT_ID,
    clientSecret: process.env.FITBIT_GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.FITBIT_GOOGLE_OAUTH_CALLBACK_URL,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env.FITBIT_GOOGLE_CLIENT_ID = "client-id";
    process.env.FITBIT_GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.FITBIT_GOOGLE_OAUTH_CALLBACK_URL = "https://example.com/fitbit/callback";
    process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries({
      FITBIT_GOOGLE_CLIENT_ID: originalEnv.clientId,
      FITBIT_GOOGLE_CLIENT_SECRET: originalEnv.clientSecret,
      FITBIT_GOOGLE_OAUTH_CALLBACK_URL: originalEnv.callbackUrl,
      TOKEN_ENCRYPTION_KEY: originalEnv.encryptionKey,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function makeContext(options?: {
    upsertError?: string;
    schedulerError?: string;
  }): Promise<{ ctx: ActionCtx; runMutation: ReturnType<typeof vi.fn> }> {
    const encryptedCode = await encryptFitbitSecret("authorization-code");
    const runQuery = vi.fn(async (ref: TestFunctionReference) => {
      const name = getFunctionName(ref);
      if (name === "lib/auth:resolveEffectiveUserId") return userId;
      throw new Error(`Unexpected query: ${name}`);
    });
    const runMutation = vi.fn(async (ref: TestFunctionReference) => {
      const name = localFunctionName(ref);
      if (name === "fitbit/oauthArtifacts:claimOauthCallbackTicket") return encryptedCode;
      if (name === "fitbit/connections:upsertActiveConnection") {
        if (options?.upsertError) throw new Error(options.upsertError);
        return { connectionId: "connection-1" };
      }
      return { ok: true };
    });
    const scheduler = {
      runAfter: vi.fn(async () => {
        if (options?.schedulerError) throw new Error(options.schedulerError);
      }),
    };
    return {
      ctx: { runQuery, runMutation, scheduler } as unknown as ActionCtx,
      runMutation,
    };
  }

  function stubNetwork(options?: {
    tokenBody?: Record<string, unknown>;
    identityStatus?: number;
  }): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === FITBIT_TOKEN_URL) {
        return new Response(
          JSON.stringify(
            options?.tokenBody ?? {
              access_token: "new-access-token",
              refresh_token: refreshToken,
              expires_in: 3600,
              token_type: "Bearer",
              scope: FITBIT_READ_SCOPES[0],
            },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `${GOOGLE_HEALTH_API_BASE_URL}/users/me/identity`) {
        return new Response(JSON.stringify({ healthUserId: "health-user-1" }), {
          status: options?.identityStatus ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === FITBIT_REVOKE_URL) return new Response(null, { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
    return fetchMock.mock.calls.map(([input]) => String(input));
  }

  it("revokes the obtained refresh token when identity lookup fails", async () => {
    const fetchMock = stubNetwork({ identityStatus: 500 });
    const { ctx } = await makeContext();

    await expect(completeHandler(ctx, { ticket })).resolves.toEqual({
      success: false,
      error: "Failed to complete Fitbit OAuth. Please try again.",
    });
    expect(requestedUrls(fetchMock)).toContain(FITBIT_REVOKE_URL);
  });

  it("revokes after duplicate-account persistence failure and preserves its message", async () => {
    const duplicateMessage = "This Fitbit account is already connected to another Roni account";
    const fetchMock = stubNetwork();
    const { ctx } = await makeContext({ upsertError: duplicateMessage });

    await expect(completeHandler(ctx, { ticket })).resolves.toEqual({
      success: false,
      error: duplicateMessage,
    });
    expect(requestedUrls(fetchMock)).toContain(FITBIT_REVOKE_URL);
  });

  it("revokes a refresh token recoverable from an otherwise malformed token response", async () => {
    const fetchMock = stubNetwork({ tokenBody: { refresh_token: refreshToken } });
    const { ctx } = await makeContext();

    await expect(completeHandler(ctx, { ticket })).resolves.toMatchObject({ success: false });
    expect(requestedUrls(fetchMock)).toEqual([FITBIT_TOKEN_URL, FITBIT_REVOKE_URL]);
  });

  it("does not revoke a token after the connection was successfully persisted", async () => {
    const fetchMock = stubNetwork();
    const { ctx, runMutation } = await makeContext({ schedulerError: "scheduler unavailable" });

    await expect(completeHandler(ctx, { ticket })).resolves.toMatchObject({ success: false });
    expect(
      runMutation.mock.calls.some(
        ([ref]) =>
          localFunctionName(ref as TestFunctionReference) ===
          "fitbit/connections:upsertActiveConnection",
      ),
    ).toBe(true);
    expect(requestedUrls(fetchMock)).not.toContain(FITBIT_REVOKE_URL);
  });
});
