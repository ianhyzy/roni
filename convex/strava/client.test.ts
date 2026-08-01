import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { decryptStravaSecret, encryptStravaSecret } from "./config";
import { fetchStravaWithTokenRetry, getStravaAccessToken } from "./client";

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;
const userId = "user-1" as Id<"users">;
const now = 1_000;
const originalEnv = {
  clientId: process.env.STRAVA_CLIENT_ID,
  clientSecret: process.env.STRAVA_CLIENT_SECRET,
  callbackUrl: process.env.STRAVA_OAUTH_CALLBACK_URL,
  encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
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

async function makeContext(options: {
  tokenExpiresAt?: number;
  leaseState?: "acquired" | "leased" | "changed";
  persist?: boolean;
  persistThrows?: boolean;
  abandon?: boolean;
}) {
  const accessTokenEncrypted = await encryptStravaSecret("current-access");
  const refreshTokenEncrypted = await encryptStravaSecret("current-refresh");
  const active = {
    userId,
    athleteId: "athlete-1",
    generation: "generation-1",
    accessTokenEncrypted,
    refreshTokenEncrypted,
    tokenExpiresAt: options.tokenExpiresAt ?? 1_000_000,
    scopes: ["activity:read"],
    connectedAt: 500,
  };
  const runQuery = vi.fn(async () => active);
  const runMutation = vi.fn(async (ref: TestFunctionReference, args: Record<string, unknown>) => {
    const name = getFunctionName(ref);
    if (name === "strava/connections:acquireRefreshLease") {
      if (options.leaseState === "leased") {
        return { state: "leased", retryAfterMs: 500 };
      }
      if (options.leaseState === "changed") return { state: "changed" };
      return { state: "acquired", refreshTokenEncrypted };
    }
    if (name === "strava/connections:persistRefreshedTokens") {
      if (options.persistThrows) throw new Error("mutation unavailable");
      return { state: options.persist === false ? "changed" : "persisted" };
    }
    if (name === "strava/connections:abandonRefresh") return options.abandon ?? true;
    if (name === "strava/connections:releaseRefreshLease") return true;
    throw new Error(`Unexpected mutation ${name}: ${JSON.stringify(Object.keys(args))}`);
  });
  return {
    ctx: { runQuery, runMutation } as unknown as ActionCtx,
    runMutation,
  };
}

beforeEach(() => {
  process.env.STRAVA_CLIENT_ID = "client-id";
  process.env.STRAVA_CLIENT_SECRET = "client-secret";
  process.env.STRAVA_OAUTH_CALLBACK_URL = "https://api.example.com/strava/oauth/callback";
  process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreEnv("STRAVA_CLIENT_ID", originalEnv.clientId);
  restoreEnv("STRAVA_CLIENT_SECRET", originalEnv.clientSecret);
  restoreEnv("STRAVA_OAUTH_CALLBACK_URL", originalEnv.callbackUrl);
  restoreEnv("TOKEN_ENCRYPTION_KEY", originalEnv.encryptionKey);
});

describe("Strava rotating-token coordination", () => {
  it("returns an unexpired encrypted access token without refreshing", async () => {
    const { ctx, runMutation } = await makeContext({});

    await expect(
      getStravaAccessToken(ctx, { userId, generation: "generation-1", now }),
    ).resolves.toEqual({
      success: true,
      accessToken: "current-access",
      tokenExpiresAt: 1_000_000,
    });
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("encrypts and persists both latest rotated tokens under the lease CAS", async () => {
    const { ctx, runMutation } = await makeContext({ tokenExpiresAt: 2_000 });
    const fetcher = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(tokenBody()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      getStravaAccessToken(ctx, {
        userId,
        generation: "generation-1",
        now,
        fetcher,
      }),
    ).resolves.toMatchObject({ success: true, accessToken: "rotated-access" });
    const persistCall = runMutation.mock.calls.find(
      ([ref]) => getFunctionName(ref) === "strava/connections:persistRefreshedTokens",
    );
    expect(persistCall).toBeDefined();
    const persisted = persistCall?.[1] as {
      accessTokenEncrypted: string;
      refreshTokenEncrypted: string;
    };
    expect(persisted.accessTokenEncrypted).not.toContain("rotated-access");
    expect(persisted.refreshTokenEncrypted).not.toContain("rotated-refresh");
    await expect(decryptStravaSecret(persisted.refreshTokenEncrypted)).resolves.toBe(
      "rotated-refresh",
    );
  });

  it("returns an explicit retryable result when another refresh owns the lease", async () => {
    const { ctx } = await makeContext({ tokenExpiresAt: 2_000, leaseState: "leased" });

    await expect(
      getStravaAccessToken(ctx, { userId, generation: "generation-1", now }),
    ).resolves.toEqual({
      success: false,
      kind: "transient",
      retryable: true,
      error: "Strava token refresh is already in progress.",
      retryAfterMs: 500,
    });
  });

  it("releases its lease when refresh validation fails", async () => {
    const { ctx, runMutation } = await makeContext({ tokenExpiresAt: 2_000 });
    const fetcher = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ access_token: "incomplete" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(
      getStravaAccessToken(ctx, { userId, generation: "generation-1", now, fetcher }),
    ).resolves.toEqual({
      success: false,
      kind: "provider_invalid_response",
      retryable: false,
      error: "Strava returned an invalid token response.",
    });
    expect(
      runMutation.mock.calls.some(
        ([ref]) => getFunctionName(ref) === "strava/connections:releaseRefreshLease",
      ),
    ).toBe(true);
  });

  it("treats provider authorization rejection as terminal and rate limiting as retryable", async () => {
    const unauthorized = await makeContext({ tokenExpiresAt: 2_000 });
    const rateLimited = await makeContext({ tokenExpiresAt: 2_000 });
    const response = (status: number) =>
      vi.fn(async () => Promise.resolve(new Response(null, { status })));

    await expect(
      getStravaAccessToken(unauthorized.ctx, {
        userId,
        generation: "generation-1",
        now,
        fetcher: response(401),
      }),
    ).resolves.toEqual({
      success: false,
      kind: "authorization_invalid",
      retryable: false,
      error: "Strava authorization is no longer valid.",
    });
    await expect(
      getStravaAccessToken(rateLimited.ctx, {
        userId,
        generation: "generation-1",
        now,
        fetcher: response(429),
      }),
    ).resolves.toEqual({
      success: false,
      kind: "transient",
      retryable: true,
      error: "Strava token refresh failed.",
    });
  });

  it("retries rotated-token persistence before abandoning and revoking the new authorization", async () => {
    const { ctx, runMutation } = await makeContext({
      tokenExpiresAt: 2_000,
      persistThrows: true,
    });
    const refreshFetcher = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(tokenBody()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const revokeFetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", revokeFetcher);

    await expect(
      getStravaAccessToken(ctx, {
        userId,
        generation: "generation-1",
        now,
        fetcher: refreshFetcher,
      }),
    ).resolves.toEqual({
      success: false,
      kind: "persistence_failed",
      retryable: false,
      error: "Strava token refresh could not be saved. Reconnect Strava.",
    });
    expect(
      runMutation.mock.calls.filter(
        ([ref]) => getFunctionName(ref) === "strava/connections:persistRefreshedTokens",
      ),
    ).toHaveLength(3);
    expect(
      runMutation.mock.calls.some(
        ([ref]) => getFunctionName(ref) === "strava/connections:abandonRefresh",
      ),
    ).toBe(true);
    expect(revokeFetcher).toHaveBeenCalledTimes(1);
  });

  it("does not revoke rotated credentials when exact-lease abandonment loses its CAS", async () => {
    const { ctx } = await makeContext({
      tokenExpiresAt: 2_000,
      persistThrows: true,
      abandon: false,
    });
    const refreshFetcher = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(tokenBody()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const revokeFetcher = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", revokeFetcher);

    await expect(
      getStravaAccessToken(ctx, {
        userId,
        generation: "generation-1",
        now,
        fetcher: refreshFetcher,
      }),
    ).resolves.toMatchObject({ success: false, retryable: false });
    expect(revokeFetcher).not.toHaveBeenCalled();
  });

  it("retries one provider request after 401 and never a third time", async () => {
    const { ctx } = await makeContext({});
    const refreshFetcher = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(tokenBody()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    const request = vi.fn<(token: string) => Promise<Response>>(async () =>
      Promise.resolve(new Response(null, { status: 401 })),
    );

    const result = await fetchStravaWithTokenRetry(ctx, {
      userId,
      generation: "generation-1",
      request,
      now,
      refreshFetcher,
    });

    expect(result.success && result.response.status).toBe(401);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([token]) => token)).toEqual([
      "current-access",
      "rotated-access",
    ]);
    expect(refreshFetcher).toHaveBeenCalledTimes(1);
  });
});
