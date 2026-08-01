import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRAVA_TOKEN_URL, type StravaAppConfig } from "./config";
import {
  exchangeStravaAuthorizationCode,
  parseInitialStravaTokenResponse,
  parseStravaTokenResponse,
  refreshStravaTokens,
  type StravaTokenFetcher,
} from "./tokenExchange";

const NOW = 1_000;
const APP_CONFIG: StravaAppConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://api.example.com/strava/oauth/callback",
};
const originalEnv = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  callbackUrl: process.env.STRAVA_OAUTH_CALLBACK_URL,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function tokenBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "rotated-access",
    refresh_token: "rotated-refresh",
    expires_at: 2_000,
    expires_in: 1_999,
    token_type: "Bearer",
    ...overrides,
  };
}

function responseFetcher(response: Response): ReturnType<typeof vi.fn<StravaTokenFetcher>> {
  return vi.fn<StravaTokenFetcher>(async () => response);
}

beforeEach(() => {
  process.env.STRAVA_CLIENT_ID = APP_CONFIG.clientId;
  process.env.STRAVA_CLIENT_SECRET = APP_CONFIG.clientSecret;
  process.env.STRAVA_OAUTH_CALLBACK_URL = APP_CONFIG.redirectUri;
});

afterEach(() => {
  restoreEnv("STRAVA_CLIENT_ID", originalEnv.clientId);
  restoreEnv("STRAVA_CLIENT_SECRET", originalEnv.clientSecret);
  restoreEnv("STRAVA_OAUTH_CALLBACK_URL", originalEnv.callbackUrl);
});

describe("Strava token parsing", () => {
  it("validates bearer tokens, expiry, and athlete identity", () => {
    expect(parseStravaTokenResponse(tokenBody(), NOW)).toEqual({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
      tokenExpiresAt: 2_000_000,
    });
    expect(
      parseInitialStravaTokenResponse({ ...tokenBody(), athlete: { id: 12345 } }, NOW),
    ).toMatchObject({ athleteId: "12345" });
  });

  it("rejects non-bearer and expired tokens", () => {
    expect(() => parseStravaTokenResponse(tokenBody({ token_type: "mac" }), NOW)).toThrow(
      "Malformed Strava OAuth token response",
    );
    expect(() => parseStravaTokenResponse(tokenBody({ expires_at: 1 }), NOW)).toThrow(
      "Malformed Strava OAuth token response",
    );
  });

  it.each([
    undefined,
    { id: 0 },
    { id: -1 },
    { id: 1.5 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { id: "00123" },
  ])("rejects an invalid athlete payload %#", (athlete) => {
    expect(() => parseInitialStravaTokenResponse({ ...tokenBody(), athlete }, NOW)).toThrow(
      "Malformed Strava OAuth token response",
    );
  });
});

describe("Strava token HTTP requests", () => {
  it("exchanges an authorization code and validates the athlete", async () => {
    const fetcher = responseFetcher(
      new Response(JSON.stringify({ ...tokenBody(), athlete: { id: "12345" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      exchangeStravaAuthorizationCode("authorization-code", APP_CONFIG, NOW, fetcher),
    ).resolves.toMatchObject({ athleteId: "12345", refreshToken: "rotated-refresh" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(STRAVA_TOKEN_URL);
    expect(String(init.body)).toContain("grant_type=authorization_code");
    expect(String(init.body)).toContain("code=authorization-code");
  });

  it("requests and returns the latest rotating refresh token", async () => {
    const fetcher = responseFetcher(
      new Response(JSON.stringify(tokenBody()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(refreshStravaTokens("current-refresh", NOW, fetcher)).resolves.toMatchObject({
      accessToken: "rotated-access",
      refreshToken: "rotated-refresh",
    });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(STRAVA_TOKEN_URL);
    expect(String(init.body)).toContain("grant_type=refresh_token");
    expect(String(init.body)).toContain("refresh_token=current-refresh");
  });

  it.each([
    [
      "authorization code exchange",
      (fetcher: StravaTokenFetcher) =>
        exchangeStravaAuthorizationCode("authorization-code", APP_CONFIG, NOW, fetcher),
    ],
    [
      "refresh",
      (fetcher: StravaTokenFetcher) => refreshStravaTokens("current-refresh", NOW, fetcher),
    ],
  ])("rejects non-OK and malformed JSON responses during %s", async (_label, request) => {
    await expect(request(responseFetcher(new Response(null, { status: 401 })))).rejects.toThrow(
      /HTTP 401/,
    );
    await expect(
      request(responseFetcher(new Response("not-json", { status: 200 }))),
    ).rejects.toThrow(/malformed JSON/);
  });
});
