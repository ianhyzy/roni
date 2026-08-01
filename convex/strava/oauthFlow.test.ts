import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  encryptStravaSecret,
  STRAVA_REQUIRED_SCOPE,
  STRAVA_REVOKE_URL,
  STRAVA_TOKEN_URL,
} from "./config";
import { disconnectMyStrava, type DisconnectStravaResult } from "./disconnect";
import {
  buildStravaAuthorizeUrl,
  completeStravaOAuth,
  type CompleteStravaOAuthResult,
  hashOAuthArtifact,
  parseInitialTokenResponse,
  parseStravaCallbackScopes,
  startStravaOAuth,
  type StartStravaOAuthResult,
} from "./oauthFlow";

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;
type CompleteHandler = (
  ctx: ActionCtx,
  args: { ticket: string },
) => Promise<CompleteStravaOAuthResult>;
type DisconnectHandler = (ctx: ActionCtx, args: object) => Promise<DisconnectStravaResult>;
type StartHandler = (ctx: ActionCtx, args: object) => Promise<StartStravaOAuthResult>;

const completeHandler = (completeStravaOAuth as unknown as { _handler: CompleteHandler })._handler;
const disconnectHandler = (disconnectMyStrava as unknown as { _handler: DisconnectHandler })
  ._handler;
const startHandler = (startStravaOAuth as unknown as { _handler: StartHandler })._handler;

function localFunctionName(ref: TestFunctionReference): string | null {
  try {
    return getFunctionName(ref);
  } catch {
    return null;
  }
}

describe("Strava OAuth helpers", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");

  it("requests exactly the normal activity read scope", () => {
    const url = new URL(
      buildStravaAuthorizeUrl(
        { clientId: "client-1", clientSecret: "secret", redirectUri: "https://app.test/cb" },
        "state-1",
      ),
    );

    expect(url.origin + url.pathname).toBe("https://www.strava.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe(STRAVA_REQUIRED_SCOPE);
    expect(url.searchParams.get("scope")).not.toContain("activity:read_all");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("keeps only activity read from callback scopes", () => {
    expect(parseStravaCallbackScopes("read,activity:read activity:write")).toEqual([
      STRAVA_REQUIRED_SCOPE,
    ]);
    expect(parseStravaCallbackScopes("activity:read_all,read")).toEqual([]);
  });

  it("hashes OAuth artifacts deterministically without retaining raw values", async () => {
    const first = await hashOAuthArtifact("raw-oauth-value");
    const second = await hashOAuthArtifact("raw-oauth-value");

    expect(first).toBe(second);
    expect(first).not.toContain("raw-oauth-value");
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("validates the token, athlete, expiry, and granted read scope", () => {
    expect(
      parseInitialTokenResponse(
        {
          access_token: "access",
          refresh_token: "refresh",
          expires_at: now / 1000 + 21_600,
          expires_in: 21_600,
          token_type: "Bearer",
          athlete: { id: 12345 },
          scope: "read,activity:read,activity:write",
        },
        [STRAVA_REQUIRED_SCOPE],
        now,
      ),
    ).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: now + 21_600_000,
      athleteId: "12345",
      scopes: [STRAVA_REQUIRED_SCOPE],
    });
  });

  it("rejects missing permission, unsafe athlete IDs, and expired tokens", () => {
    const valid = {
      access_token: "access",
      refresh_token: "refresh",
      expires_at: now / 1000 + 21_600,
      expires_in: 21_600,
      token_type: "Bearer",
      athlete: { id: 12345 },
      scope: STRAVA_REQUIRED_SCOPE,
    };

    expect(() => parseInitialTokenResponse(valid, ["read"], now)).toThrow(
      "Strava did not grant activity read access",
    );
    expect(() =>
      parseInitialTokenResponse(
        { ...valid, athlete: { id: Number.MAX_SAFE_INTEGER + 1 } },
        [STRAVA_REQUIRED_SCOPE],
        now,
      ),
    ).toThrow("Malformed Strava OAuth token response");
    expect(() =>
      parseInitialTokenResponse({ ...valid, expires_at: now / 1000 }, [STRAVA_REQUIRED_SCOPE], now),
    ).toThrow("Malformed Strava OAuth token response");
  });
});

describe("Strava OAuth actions", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const userId = "user-1" as Id<"users">;
  const ticket = "strava-callback-ticket-123";
  const originalEnv = {
    clientId: process.env.STRAVA_CLIENT_ID,
    clientSecret: process.env.STRAVA_CLIENT_SECRET,
    callbackUrl: process.env.STRAVA_OAUTH_CALLBACK_URL,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env.STRAVA_CLIENT_ID = "client-id";
    process.env.STRAVA_CLIENT_SECRET = "client-secret";
    process.env.STRAVA_OAUTH_CALLBACK_URL = "https://example.com/strava/callback";
    process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    const values = {
      STRAVA_CLIENT_ID: originalEnv.clientId,
      STRAVA_CLIENT_SECRET: originalEnv.clientSecret,
      STRAVA_OAUTH_CALLBACK_URL: originalEnv.callbackUrl,
      TOKEN_ENCRYPTION_KEY: originalEnv.encryptionKey,
    };
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function makeCompleteContext(upsertError?: string): Promise<ActionCtx> {
    const encryptedCode = await encryptStravaSecret("authorization-code");
    const runQuery = vi.fn(async (ref: TestFunctionReference) => {
      const name = getFunctionName(ref);
      if (name === "lib/auth:resolveEffectiveUserId") return userId;
      if (name === "strava/status:hasActiveConnectionByUserId") return false;
      throw new Error("Unexpected query");
    });
    const runMutation = vi.fn(async (ref: TestFunctionReference) => {
      const name = localFunctionName(ref);
      if (name === "strava/oauthArtifacts:claimOauthCallbackTicket") {
        return {
          state: "claimed",
          artifact: {
            authorizationCodeEncrypted: encryptedCode,
            acceptedScopes: [STRAVA_REQUIRED_SCOPE],
          },
        };
      }
      if (name === "strava/connections:upsertActiveConnection") {
        if (upsertError) throw new Error(upsertError);
        return { connectionId: "connection-1" };
      }
      return { ok: true };
    });
    return {
      runQuery,
      runMutation,
    } as unknown as ActionCtx;
  }

  function stubTokenNetwork(tokenBody?: Record<string, unknown>): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === STRAVA_TOKEN_URL) {
        return new Response(
          JSON.stringify(
            tokenBody ?? {
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_at: now / 1000 + 21_600,
              expires_in: 21_600,
              token_type: "Bearer",
              athlete: { id: 12345 },
              scope: STRAVA_REQUIRED_SCOPE,
            },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === STRAVA_REVOKE_URL) return new Response(null, { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("rejects unauthenticated OAuth initiation", async () => {
    const ctx = {
      runQuery: vi.fn(async () => null),
      runMutation: vi.fn(),
    } as unknown as ActionCtx;

    await expect(startHandler(ctx, {})).resolves.toEqual({
      success: false,
      error: "Not authenticated",
    });
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("persists valid tokens without exposing or revoking them", async () => {
    const fetchMock = stubTokenNetwork();
    const ctx = await makeCompleteContext();

    await expect(completeHandler(ctx, { ticket })).resolves.toEqual({ success: true });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([STRAVA_TOKEN_URL]);
  });

  it("does not revoke another owner's athlete authorization on an ownership collision", async () => {
    const duplicate = "This Strava account is already connected to another Roni account";
    const fetchMock = stubTokenNetwork();
    const ctx = await makeCompleteContext(duplicate);

    await expect(completeHandler(ctx, { ticket })).resolves.toEqual({
      success: false,
      error: duplicate,
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([STRAVA_TOKEN_URL]);
  });

  it("revokes a recoverable access token from an otherwise malformed response", async () => {
    const fetchMock = stubTokenNetwork({ access_token: "new-access-token" });
    const ctx = await makeCompleteContext();

    await expect(completeHandler(ctx, { ticket })).resolves.toMatchObject({ success: false });
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      STRAVA_TOKEN_URL,
      STRAVA_REVOKE_URL,
    ]);
  });

  it("disconnects locally even when remote revocation is rejected", async () => {
    const encryptedAccess = await encryptStravaSecret("access-token");
    const callOrder: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callOrder.push("revoke");
        return new Response(null, { status: 401 });
      }),
    );
    const ctx = {
      runQuery: vi.fn(async () => userId),
      runMutation: vi.fn(async (ref: TestFunctionReference) => {
        const name = localFunctionName(ref);
        if (name === "strava/connections:claimDisconnect") {
          callOrder.push("disconnect");
          return {
            state: "claimed",
            generation: "generation-1",
            accessTokenEncrypted: encryptedAccess,
          };
        }
        return { ok: true };
      }),
    } as unknown as ActionCtx;

    await expect(disconnectHandler(ctx, {})).resolves.toEqual({
      success: true,
      revocation: "failed",
    });
    expect(callOrder).toEqual(["disconnect", "revoke"]);
  });

  it("returns a retryable lease result at the clipped polling deadline", async () => {
    const runMutation = vi.fn(async (ref: TestFunctionReference) => {
      if (localFunctionName(ref) === "strava/connections:claimDisconnect") {
        return { state: "leased" as const, retryAfterMs: 60_000 };
      }
      return { ok: true };
    });
    const ctx = {
      runQuery: vi.fn(async () => userId),
      runMutation,
    } as unknown as ActionCtx;

    const result = disconnectHandler(ctx, {});
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(result).resolves.toEqual({
      success: false,
      retryable: true,
      error: "Strava is finishing a token refresh. Please try disconnecting again.",
    });
    const claimCalls = runMutation.mock.calls.filter(
      ([ref]) => localFunctionName(ref) === "strava/connections:claimDisconnect",
    );
    expect(claimCalls).toHaveLength(1);
    expect(vi.getMockedSystemTime()?.getTime()).toBe(now + 5_000);
  });
});
