import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { decryptStravaSecret, encryptStravaSecret } from "./config";
import { revokeStravaTokenWithRetry } from "./tokenRevocation";
import { refreshStravaTokens, type StravaTokenFetcher } from "./tokenExchange";

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const REFRESH_LEASE_MS = 60_000;
const TOKEN_PERSIST_MAX_ATTEMPTS = 3;

type TokenContext = Pick<ActionCtx, "runQuery" | "runMutation">;
type ActiveConnection = {
  userId: Id<"users">;
  athleteId: string;
  generation: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: number;
  scopes: string[];
  connectedAt: number;
  refreshLeaseNonce?: string;
  refreshLeaseExpiresAt?: number;
};
type RotatedTokenPersistence = { state: "persisted" } | { state: "changed" };
type RotatedTokenPersistenceArgs = {
  userId: Id<"users">;
  generation: string;
  expectedTokenExpiresAt: number;
  leaseNonce: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: number;
  refreshDueAt: number;
};

export type StravaFailureKind =
  | "authorization_invalid"
  | "provider_invalid_response"
  | "connection_changed"
  | "persistence_failed"
  | "transient";

type StravaFailure = {
  success: false;
  kind: StravaFailureKind;
  retryable: boolean;
  error: string;
  retryAfterMs?: number;
};

export type StravaAccessTokenResult =
  { success: true; accessToken: string; tokenExpiresAt: number } | StravaFailure;

export type StravaAuthorizedFetchResult = { success: true; response: Response } | StravaFailure;

function generateLeaseNonce(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function latestConnection(
  ctx: TokenContext,
  userId: Id<"users">,
): Promise<ActiveConnection | null> {
  return ctx.runQuery(internal.strava.connections.getActiveConnectionByUserId, { userId });
}

async function readLatestRotatedToken(
  ctx: TokenContext,
  userId: Id<"users">,
  generation: string,
  previousExpiry: number,
): Promise<StravaAccessTokenResult> {
  const latest = await latestConnection(ctx, userId);
  if (latest?.generation === generation && latest.tokenExpiresAt !== previousExpiry) {
    return {
      success: true,
      accessToken: await decryptStravaSecret(latest.accessTokenEncrypted),
      tokenExpiresAt: latest.tokenExpiresAt,
    };
  }
  return {
    success: false,
    kind: "connection_changed",
    retryable: true,
    error: "Strava connection changed during refresh.",
  };
}

async function persistRotatedTokens(
  ctx: TokenContext,
  args: RotatedTokenPersistenceArgs,
): Promise<RotatedTokenPersistence> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TOKEN_PERSIST_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await ctx.runMutation(internal.strava.connections.persistRefreshedTokens, args);
    } catch (error) {
      lastError = error;
    }
  }
  const persistenceError = new Error("Failed to persist rotated Strava tokens");
  Object.defineProperty(persistenceError, "cause", { value: lastError, configurable: true });
  throw persistenceError;
}

async function revokeRotatedToken(
  accessToken: string,
  connection: ActiveConnection,
): Promise<void> {
  const revoked = await revokeStravaTokenWithRetry(accessToken).catch(() => false);
  if (!revoked) {
    console.error("[strava] failed to revoke unpersisted rotated tokens", {
      userId: connection.userId,
      generation: connection.generation,
    });
  }
}

async function refreshConnectionToken(
  ctx: TokenContext,
  connection: ActiveConnection,
  now: number,
  fetcher: StravaTokenFetcher,
): Promise<StravaAccessTokenResult> {
  const leaseNonce = generateLeaseNonce();
  const lease = await ctx.runMutation(internal.strava.connections.acquireRefreshLease, {
    userId: connection.userId,
    generation: connection.generation,
    expectedTokenExpiresAt: connection.tokenExpiresAt,
    leaseNonce,
    now,
    leaseExpiresAt: now + REFRESH_LEASE_MS,
  });
  if (lease.state === "leased") {
    return {
      success: false,
      kind: "transient",
      retryable: true,
      error: "Strava token refresh is already in progress.",
      retryAfterMs: lease.retryAfterMs,
    };
  }
  if (lease.state === "changed") {
    return readLatestRotatedToken(
      ctx,
      connection.userId,
      connection.generation,
      connection.tokenExpiresAt,
    );
  }

  let tokens;
  try {
    tokens = await refreshStravaTokens(
      await decryptStravaSecret(lease.refreshTokenEncrypted),
      now,
      fetcher,
    );
  } catch (error) {
    try {
      await ctx.runMutation(internal.strava.connections.releaseRefreshLease, {
        userId: connection.userId,
        generation: connection.generation,
        leaseNonce,
      });
    } catch {
      // The lease expires automatically; do not mask the provider failure.
    }
    const message = error instanceof Error ? error.message : "";
    if (/HTTP (400|401|403)\b/.test(message)) {
      return {
        success: false,
        kind: "authorization_invalid",
        retryable: false,
        error: "Strava authorization is no longer valid.",
      };
    }
    if (message === "Malformed Strava OAuth token response") {
      return {
        success: false,
        kind: "provider_invalid_response",
        retryable: false,
        error: "Strava returned an invalid token response.",
      };
    }
    return {
      success: false,
      kind: "transient",
      retryable: true,
      error: "Strava token refresh failed.",
    };
  }

  let persistence: RotatedTokenPersistence;
  try {
    persistence = await persistRotatedTokens(ctx, {
      userId: connection.userId,
      generation: connection.generation,
      expectedTokenExpiresAt: connection.tokenExpiresAt,
      leaseNonce,
      accessTokenEncrypted: await encryptStravaSecret(tokens.accessToken),
      refreshTokenEncrypted: await encryptStravaSecret(tokens.refreshToken),
      tokenExpiresAt: tokens.tokenExpiresAt,
      refreshDueAt: Math.max(now, tokens.tokenExpiresAt - TOKEN_REFRESH_SKEW_MS),
    });
  } catch {
    const abandoned = await ctx
      .runMutation(internal.strava.connections.abandonRefresh, {
        userId: connection.userId,
        generation: connection.generation,
        expectedTokenExpiresAt: connection.tokenExpiresAt,
        leaseNonce,
        now,
      })
      .catch(() => false);
    const latest = abandoned ? null : await latestConnection(ctx, connection.userId);
    if (
      latest?.generation === connection.generation &&
      latest.tokenExpiresAt !== connection.tokenExpiresAt
    ) {
      return {
        success: true,
        accessToken: await decryptStravaSecret(latest.accessTokenEncrypted),
        tokenExpiresAt: latest.tokenExpiresAt,
      };
    }
    if (abandoned || !latest) {
      await revokeRotatedToken(tokens.accessToken, connection);
    }
    return {
      success: false,
      kind: "persistence_failed",
      retryable: false,
      error: "Strava token refresh could not be saved. Reconnect Strava.",
    };
  }

  if (persistence.state === "persisted") {
    return {
      success: true,
      accessToken: tokens.accessToken,
      tokenExpiresAt: tokens.tokenExpiresAt,
    };
  }

  const latest = await latestConnection(ctx, connection.userId);
  if (
    latest?.generation === connection.generation &&
    latest.tokenExpiresAt !== connection.tokenExpiresAt
  ) {
    return {
      success: true,
      accessToken: await decryptStravaSecret(latest.accessTokenEncrypted),
      tokenExpiresAt: latest.tokenExpiresAt,
    };
  }
  if (!latest) {
    await revokeRotatedToken(tokens.accessToken, connection);
    return {
      success: false,
      kind: "connection_changed",
      retryable: false,
      error: "Strava disconnected during token refresh.",
    };
  }
  return {
    success: false,
    kind: "connection_changed",
    retryable: true,
    error: "Strava connection changed during refresh.",
  };
}

export async function getStravaAccessToken(
  ctx: TokenContext,
  args: {
    userId: Id<"users">;
    generation: string;
    forceRefresh?: boolean;
    now?: number;
    fetcher?: StravaTokenFetcher;
  },
): Promise<StravaAccessTokenResult> {
  const now = args.now ?? Date.now();
  const connection = await latestConnection(ctx, args.userId);
  if (!connection || connection.generation !== args.generation) {
    return {
      success: false,
      kind: "connection_changed",
      retryable: false,
      error: "Strava is not connected.",
    };
  }
  if (!args.forceRefresh && connection.tokenExpiresAt > now + TOKEN_REFRESH_SKEW_MS) {
    return {
      success: true,
      accessToken: await decryptStravaSecret(connection.accessTokenEncrypted),
      tokenExpiresAt: connection.tokenExpiresAt,
    };
  }
  return refreshConnectionToken(ctx, connection, now, args.fetcher ?? fetch);
}

export async function fetchStravaWithTokenRetry(
  ctx: TokenContext,
  args: {
    userId: Id<"users">;
    generation: string;
    request: (accessToken: string) => Promise<Response>;
    now?: number;
    refreshFetcher?: StravaTokenFetcher;
  },
): Promise<StravaAuthorizedFetchResult> {
  const token = await getStravaAccessToken(ctx, {
    userId: args.userId,
    generation: args.generation,
    now: args.now,
    fetcher: args.refreshFetcher,
  });
  if (!token.success) return token;
  try {
    const response = await args.request(token.accessToken);
    if (response.status !== 401) return { success: true, response };

    const refreshed = await getStravaAccessToken(ctx, {
      userId: args.userId,
      generation: args.generation,
      forceRefresh: true,
      now: args.now,
      fetcher: args.refreshFetcher,
    });
    if (!refreshed.success) return refreshed;
    return { success: true, response: await args.request(refreshed.accessToken) };
  } catch {
    return {
      success: false,
      kind: "transient",
      retryable: true,
      error: "Strava request failed.",
    };
  }
}
