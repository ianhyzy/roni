import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRAVA_REVOKE_URL } from "./config";
import { revokeStravaTokenWithRetry } from "./tokenRevocation";

const originalEnv = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  callbackUrl: process.env.STRAVA_OAUTH_CALLBACK_URL,
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("Strava token revocation", () => {
  beforeEach(() => {
    process.env.STRAVA_CLIENT_ID = "client-id";
    process.env.STRAVA_CLIENT_SECRET = "client-secret";
    process.env.STRAVA_OAUTH_CALLBACK_URL = "https://api.example.com/strava/oauth/callback";
  });

  afterEach(() => {
    restoreEnv("STRAVA_CLIENT_ID", originalEnv.clientId);
    restoreEnv("STRAVA_CLIENT_SECRET", originalEnv.clientSecret);
    restoreEnv("STRAVA_OAUTH_CALLBACK_URL", originalEnv.callbackUrl);
  });

  it("uses the current revoke endpoint with Basic client auth and form token", async () => {
    const fetcher = vi.fn<(input: string, init: RequestInit) => Promise<Response>>(async () =>
      Promise.resolve(new Response(null, { status: 200 })),
    );

    await expect(revokeStravaTokenWithRetry("access-token", { fetcher })).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(STRAVA_REVOKE_URL);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      `Basic ${btoa("client-id:client-secret")}`,
    );
    expect(String(init.body)).toBe("token=access-token");
  });

  it("retries transient responses and network failures without exceeding three attempts", async () => {
    const fetcher = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const wait = vi.fn(async () => undefined);

    await expect(
      revokeStravaTokenWithRetry("access-token", {
        fetcher,
        random: () => 0,
        sleep: wait,
      }),
    ).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("does not retry a permanent provider rejection", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    const wait = vi.fn(async () => undefined);

    await expect(
      revokeStravaTokenWithRetry("access-token", { fetcher, sleep: wait }),
    ).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("fails closed when client credentials are unavailable", async () => {
    delete process.env.STRAVA_CLIENT_SECRET;
    const fetcher = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(revokeStravaTokenWithRetry("access-token", { fetcher })).rejects.toThrow(
      "Strava is not configured",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
