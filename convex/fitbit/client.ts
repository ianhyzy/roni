import { z } from "zod";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  decryptFitbitSecret,
  encryptFitbitSecret,
  FITBIT_READ_SCOPES,
  FITBIT_TOKEN_URL,
  type FitbitReadScope,
  getFitbitAppConfig,
  GOOGLE_HEALTH_API_BASE_URL,
  supportedFitbitScopes,
} from "./config";
import { resolveLostFitbitTokenRefresh } from "./tokenRevocation";

const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_LIST_PAGES = 20;
const MAX_SYNC_LIST_PAGES = 24;
const MAX_SYNC_LIST_DURATION_MS = 4 * 60 * 1000;
const dataPointSchema = z
  .object({
    name: z.string().min(1),
    dataSource: z.object({ platform: z.string() }).passthrough(),
  })
  .passthrough();
const dataPointsResponseSchema = z
  .object({
    dataPoints: z.array(dataPointSchema).default([]),
    nextPageToken: z.string().optional(),
  })
  .passthrough();
const refreshTokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional(),
    expires_in: z.number().finite().positive(),
    token_type: z.string().min(1),
    scope: z.string().min(1).optional(),
  })
  .passthrough();
const oauthErrorSchema = z.object({ error: z.string() }).passthrough();
const googleErrorSchema = z
  .object({
    error: z
      .object({
        details: z.array(z.object({ reason: z.string().optional() }).passthrough()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type FitbitDataType =
  "exercise" | "sleep" | "daily-resting-heart-rate" | "daily-heart-rate-variability";

export interface FitbitListBudget {
  deadlineAt: number;
  remainingPages: number;
}

export function createFitbitListBudget(now = Date.now()): FitbitListBudget {
  return {
    deadlineAt: now + MAX_SYNC_LIST_DURATION_MS,
    remainingPages: MAX_SYNC_LIST_PAGES,
  };
}

const ACTIVITY_SCOPE = FITBIT_READ_SCOPES[0];
const HEALTH_METRICS_SCOPE = FITBIT_READ_SCOPES[1];
const SLEEP_SCOPE = FITBIT_READ_SCOPES[2];

export const FITBIT_SCOPE_BY_DATA_TYPE: Readonly<Record<FitbitDataType, FitbitReadScope>> = {
  exercise: ACTIVITY_SCOPE,
  sleep: SLEEP_SCOPE,
  "daily-resting-heart-rate": HEALTH_METRICS_SCOPE,
  "daily-heart-rate-variability": HEALTH_METRICS_SCOPE,
};

export function fitbitDataTypesForScopes(scopes: readonly string[]): FitbitDataType[] {
  const granted = new Set(supportedFitbitScopes(scopes));
  return (Object.keys(FITBIT_SCOPE_BY_DATA_TYPE) as FitbitDataType[]).filter((dataType) =>
    granted.has(FITBIT_SCOPE_BY_DATA_TYPE[dataType]),
  );
}

export interface ParsedRefreshTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

export function parseRefreshTokenResponse(
  raw: unknown,
  existingRefreshToken: string,
  existingScopes: readonly string[],
): ParsedRefreshTokenResponse {
  const parsed = refreshTokenResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new Error("Malformed Google OAuth refresh response");
  }
  const scopes = supportedFitbitScopes(
    parsed.data.scope ? parsed.data.scope.split(/\s+/) : existingScopes,
  );
  if (scopes.length === 0) {
    throw new Error("Google OAuth refresh granted no supported Fitbit read scopes");
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? existingRefreshToken,
    expiresInSeconds: parsed.data.expires_in,
    scopes,
  };
}

export function parseDataPointsResponse(raw: unknown): {
  dataPoints: z.infer<typeof dataPointSchema>[];
  nextPageToken?: string;
} {
  const parsed = dataPointsResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Malformed Google Health data-points response");
  return parsed.data;
}

export function googleForbiddenReason(raw: unknown): string | null {
  const parsed = googleErrorSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.error.details?.find((detail) => detail.reason)?.reason ?? null;
}

export function buildDataPointsUrl({
  dataType,
  filter,
  pageToken,
}: {
  dataType: FitbitDataType;
  filter: string;
  pageToken?: string;
}): string {
  const url = new URL(`${GOOGLE_HEALTH_API_BASE_URL}/users/me/dataTypes/${dataType}/dataPoints`);
  url.searchParams.set("pageSize", "25");
  url.searchParams.set("filter", filter);
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url.toString();
}

async function parseJson(response: Response, errorMessage: string): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") throw new Error(errorMessage);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(errorMessage);
  }
}

function requestTimeoutMs(budget: FitbitListBudget): number {
  const remainingMs = budget.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error("Google Health aggregate request time budget exceeded");
  }
  return Math.max(1, Math.min(FETCH_TIMEOUT_MS, remainingMs));
}

async function disconnectForAuthFailure(
  ctx: Pick<ActionCtx, "runMutation">,
  userId: Id<"users">,
  generation: string,
  reason: "permission_revoked" | "token_invalid",
  expectedTokenExpiresAt?: number,
): Promise<boolean> {
  return ctx.runMutation(internal.fitbit.connections.markDisconnected, {
    userId,
    generation,
    reason,
    now: Date.now(),
    ...(expectedTokenExpiresAt === undefined ? {} : { expectedTokenExpiresAt }),
  });
}

async function refreshAccessToken(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  userId: Id<"users">,
  connection: Extract<Doc<"fitbitConnections">, { status: "active" }>,
  budget: FitbitListBudget,
): Promise<string> {
  const refreshToken = await decryptFitbitSecret(connection.refreshTokenEncrypted);
  const config = getFitbitAppConfig();
  const response = await fetch(FITBIT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(requestTimeoutMs(budget)),
  });
  const raw = await parseJson(response, "Malformed Google OAuth refresh response");
  if (!response.ok) {
    const oauthError = oauthErrorSchema.safeParse(raw);
    if (oauthError.success && oauthError.data.error === "invalid_grant") {
      const disconnected = await disconnectForAuthFailure(
        ctx,
        userId,
        connection.generation,
        "token_invalid",
        connection.tokenExpiresAt,
      );
      if (disconnected) throw new Error("Fitbit authorization expired. Reconnect Fitbit.");

      const latest = await ctx.runQuery(internal.fitbit.connections.getActiveConnectionByUserId, {
        userId,
      });
      if (!latest || latest.generation !== connection.generation) {
        throw new Error("Fitbit connection changed during sync");
      }
      return decryptFitbitSecret(latest.accessTokenEncrypted);
    }
    throw new Error(`Google OAuth refresh failed with HTTP ${response.status}`);
  }

  const refreshed = parseRefreshTokenResponse(raw, refreshToken, connection.scopes);
  const now = Date.now();
  const tokenExpiresAt = now + refreshed.expiresInSeconds * 1000;
  const refreshDueAt = Math.max(
    now,
    Math.min(now + SYNC_INTERVAL_MS, tokenExpiresAt - REFRESH_SKEW_MS),
  );
  const saved = await ctx.runMutation(internal.fitbit.connections.replaceTokens, {
    userId,
    generation: connection.generation,
    accessTokenEncrypted: await encryptFitbitSecret(refreshed.accessToken),
    refreshTokenEncrypted: await encryptFitbitSecret(refreshed.refreshToken),
    tokenExpiresAt,
    expectedTokenExpiresAt: connection.tokenExpiresAt,
    scopes: refreshed.scopes,
    refreshDueAt,
  });
  if (saved) return refreshed.accessToken;

  return resolveLostFitbitTokenRefresh(ctx, {
    userId,
    generation: connection.generation,
    discardedRefreshToken: refreshed.refreshToken,
  });
}

async function getAccessToken(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  userId: Id<"users">,
  generation: string,
  dataType: FitbitDataType,
  forceRefresh: boolean,
  budget: FitbitListBudget,
): Promise<string> {
  const connection = await ctx.runQuery(internal.fitbit.connections.getActiveConnectionByUserId, {
    userId,
  });
  if (!connection || connection.generation !== generation) {
    throw new Error("Fitbit connection changed during sync");
  }
  if (!connection.scopes.includes(FITBIT_SCOPE_BY_DATA_TYPE[dataType])) {
    throw new Error(`Fitbit permission is not granted for ${dataType}`);
  }
  if (forceRefresh || connection.tokenExpiresAt <= Date.now() + REFRESH_SKEW_MS) {
    return refreshAccessToken(ctx, userId, connection, budget);
  }
  return decryptFitbitSecret(connection.accessTokenEncrypted);
}

async function authorizedGet(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  userId: Id<"users">,
  generation: string,
  dataType: FitbitDataType,
  url: string,
  budget: FitbitListBudget,
): Promise<Response> {
  const request = async (accessToken: string) =>
    fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(requestTimeoutMs(budget)),
    });

  let response = await request(
    await getAccessToken(ctx, userId, generation, dataType, false, budget),
  );
  if (response.status === 401) {
    response = await request(await getAccessToken(ctx, userId, generation, dataType, true, budget));
    if (response.status === 401) {
      await disconnectForAuthFailure(ctx, userId, generation, "token_invalid");
      throw new Error("Fitbit authorization expired. Reconnect Fitbit.");
    }
  }
  if (response.status === 403) {
    let reason: string | null = null;
    try {
      reason = googleForbiddenReason(await response.clone().json());
    } catch {
      // A malformed 403 is not evidence that consent was revoked.
    }
    if (reason === "MISSING_OAUTH_SCOPE") {
      const result = await ctx.runMutation(internal.fitbit.connections.removeGrantedScope, {
        userId,
        generation,
        scope: FITBIT_SCOPE_BY_DATA_TYPE[dataType],
        now: Date.now(),
      });
      if (result.disconnected) {
        throw new Error("Fitbit permissions were revoked. Reconnect Fitbit.");
      }
      throw new Error(`Fitbit permission is not granted for ${dataType}`);
    }
  }
  return response;
}

export async function listFitbitDataPoints(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  {
    userId,
    generation,
    dataType,
    filter,
    budget,
  }: {
    userId: Id<"users">;
    generation: string;
    dataType: FitbitDataType;
    filter: string;
    budget: FitbitListBudget;
  },
): Promise<unknown[]> {
  return collectDataPointPages(
    async (pageToken) => {
      const response = await authorizedGet(
        ctx,
        userId,
        generation,
        dataType,
        buildDataPointsUrl({ dataType, filter, pageToken }),
        budget,
      );
      if (!response.ok) {
        throw new Error(`Google Health ${dataType} request failed with HTTP ${response.status}`);
      }
      return parseDataPointsResponse(
        await parseJson(response, "Malformed Google Health data-points response"),
      );
    },
    MAX_LIST_PAGES,
    budget,
  );
}

export async function collectDataPointPages(
  fetchPage: (pageToken?: string) => Promise<{
    dataPoints: readonly unknown[];
    nextPageToken?: string;
  }>,
  maxPages = MAX_LIST_PAGES,
  budget?: FitbitListBudget,
): Promise<unknown[]> {
  const points: unknown[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (budget) {
      if (budget.remainingPages <= 0) {
        throw new Error("Google Health pagination exceeded the aggregate page budget");
      }
      requestTimeoutMs(budget);
      budget.remainingPages -= 1;
    }
    const parsed = await fetchPage(pageToken);
    if (budget) requestTimeoutMs(budget);
    points.push(...parsed.dataPoints);
    if (!parsed.nextPageToken) return points;
    if (seenTokens.has(parsed.nextPageToken)) {
      throw new Error("Google Health returned a repeated page token");
    }
    seenTokens.add(parsed.nextPageToken);
    pageToken = parsed.nextPageToken;
  }
  throw new Error("Google Health pagination exceeded the bounded page limit");
}
