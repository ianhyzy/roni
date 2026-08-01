import { z } from "zod";
import { getStravaAppConfig, STRAVA_TOKEN_URL, type StravaAppConfig } from "./config";

const FETCH_TIMEOUT_MS = 15_000;
const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_at: z.number().int().positive(),
    expires_in: z.number().finite().positive(),
    token_type: z.string().min(1),
  })
  .passthrough();
const athleteIdSchema = z.union([
  z.number().int().positive().safe(),
  z.string().regex(/^[1-9][0-9]*$/),
]);
const initialTokenResponseSchema = tokenResponseSchema.extend({
  athlete: z.object({ id: athleteIdSchema }).passthrough(),
});

export type StravaTokenFetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface ParsedStravaTokenResponse {
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
}

export interface ParsedInitialStravaTokenResponse extends ParsedStravaTokenResponse {
  athleteId: string;
}

function validateTokenExpiry(expiresAtSeconds: number, now: number): number {
  const tokenExpiresAt = expiresAtSeconds * 1000;
  if (!Number.isSafeInteger(tokenExpiresAt) || tokenExpiresAt <= now) {
    throw new Error("Malformed Strava OAuth token response");
  }
  return tokenExpiresAt;
}

export function parseStravaTokenResponse(raw: unknown, now: number): ParsedStravaTokenResponse {
  const parsed = tokenResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new Error("Malformed Strava OAuth token response");
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    tokenExpiresAt: validateTokenExpiry(parsed.data.expires_at, now),
  };
}

export function parseInitialStravaTokenResponse(
  raw: unknown,
  now: number,
): ParsedInitialStravaTokenResponse {
  const parsed = initialTokenResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new Error("Malformed Strava OAuth token response");
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    tokenExpiresAt: validateTokenExpiry(parsed.data.expires_at, now),
    athleteId: String(parsed.data.athlete.id),
  };
}

async function responseJson(response: Response, errorMessage: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${errorMessage}: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${errorMessage}: malformed JSON`);
  }
}

async function requestTokens(
  params: URLSearchParams,
  now: number,
  fetcher: StravaTokenFetcher,
): Promise<ParsedStravaTokenResponse> {
  const response = await fetcher(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return parseStravaTokenResponse(await responseJson(response, "Strava token request failed"), now);
}

export async function exchangeStravaAuthorizationCode(
  code: string,
  config: StravaAppConfig,
  now: number,
  fetcher: StravaTokenFetcher = fetch,
): Promise<ParsedInitialStravaTokenResponse> {
  const response = await fetcher(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return parseInitialStravaTokenResponse(
    await responseJson(response, "Strava token exchange failed"),
    now,
  );
}

export async function refreshStravaTokens(
  refreshToken: string,
  now: number,
  fetcher: StravaTokenFetcher = fetch,
): Promise<ParsedStravaTokenResponse> {
  const config = getStravaAppConfig();
  return requestTokens(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    now,
    fetcher,
  );
}
