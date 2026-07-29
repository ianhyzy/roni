import { afterEach, describe, expect, it, vi } from "vitest";
import { obtainTonalToken, refreshTonalToken } from "./auth";

const TOKEN_URL = "https://tonal.auth0.com/oauth/token";
const CLIENT_ID = "ERCyexW-xoVG_Yy3RDe-eV4xsOnRHP6L";
const NOW = 1_750_000_000_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jwtWithPayload(payload: Readonly<Record<string, unknown>>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${encoded}.signature`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn<Fetcher>().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("obtainTonalToken", () => {
  it("sends the exact Auth0 password-realm request and derives expiry from the JWT", async () => {
    const idToken = jwtWithPayload({ exp: 1_800_000_000, marker: "\u0080\u00be\u0083\u00f0" });
    const fetchMock = stubFetch(
      jsonResponse({ id_token: idToken, refresh_token: "new-refresh-token" }),
    );

    const result = await obtainTonalToken("athlete@example.com", "correct horse battery staple");

    expect(idToken.split(".")[1]).toEqual(expect.stringMatching(/[-_]/));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "http://auth0.com/oauth/grant-type/password-realm",
        username: "athlete@example.com",
        password: "correct horse battery staple",
        realm: "Username-Password-Authentication",
        client_id: CLIENT_ID,
        scope: "openid profile email offline_access",
      }),
    });
    expect(result).toEqual({
      idToken,
      refreshToken: "new-refresh-token",
      expiresAt: 1_800_000_000_000,
    });
  });

  it("maps Auth0 wrong-credential responses to the stable credential error", async () => {
    stubFetch(jsonResponse({ error_description: "Wrong email or password." }, 403));

    await expect(obtainTonalToken("athlete@example.com", "wrong-password")).rejects.toThrow(
      "tonal_invalid_credentials",
    );
  });

  it("surfaces non-credential Auth0 error descriptions", async () => {
    stubFetch(jsonResponse({ error_description: "Password realm is disabled" }, 400));

    await expect(obtainTonalToken("athlete@example.com", "password")).rejects.toThrow(
      "Password realm is disabled",
    );
  });

  it("uses an explicit fallback when Auth0 returns a non-JSON error", async () => {
    stubFetch(new Response("upstream unavailable", { status: 503 }));

    await expect(obtainTonalToken("athlete@example.com", "password")).rejects.toThrow(
      "Unknown error",
    );
  });
});

describe("refreshTonalToken", () => {
  it("sends the exact refresh grant request and returns a rotated refresh token", async () => {
    const idToken = jwtWithPayload({ exp: 1_900_000_000 });
    const fetchMock = stubFetch(
      jsonResponse({ id_token: idToken, refresh_token: "rotated-refresh-token" }),
    );

    const result = await refreshTonalToken("existing-refresh-token");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: "existing-refresh-token",
      }),
    });
    expect(result).toEqual({
      idToken,
      refreshToken: "rotated-refresh-token",
      expiresAt: 1_900_000_000_000,
    });
  });

  it("retains the existing refresh token when Auth0 does not rotate it", async () => {
    const idToken = jwtWithPayload({ exp: 1_900_000_000 });
    stubFetch(jsonResponse({ id_token: idToken }));

    const result = await refreshTonalToken("existing-refresh-token");

    expect(result.refreshToken).toBe("existing-refresh-token");
  });

  it("requires re-authentication after a failed refresh request", async () => {
    stubFetch(jsonResponse({ error: "invalid_grant" }, 401));

    await expect(refreshTonalToken("expired-refresh-token")).rejects.toThrow(
      "Tonal token refresh failed — user must re-authenticate",
    );
  });
});

describe("JWT expiry fallback", () => {
  it.each([
    ["a malformed JWT", "not-a-jwt"],
    ["a JWT without an exp claim", jwtWithPayload({ sub: "auth0|tonal-user" })],
  ])("falls back to 24 hours from now for %s", async (_case, idToken) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    stubFetch(jsonResponse({ id_token: idToken, refresh_token: "refresh-token" }));

    const result = await obtainTonalToken("athlete@example.com", "password");

    expect(result.expiresAt).toBe(NOW + ONE_DAY_MS);
  });
});
