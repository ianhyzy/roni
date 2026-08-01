import { isRateLimitError } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { action, internalAction } from "../_generated/server";
import { rateLimiter } from "../rateLimits";
import { parseInitialStravaTokenResponse } from "./tokenExchange";
import {
  decryptStravaSecret,
  encryptStravaSecret,
  getStravaAppConfig,
  isStravaConfigured,
  STRAVA_AUTHORIZE_URL,
  STRAVA_REQUIRED_SCOPE,
  STRAVA_TOKEN_URL,
  type StravaAppConfig,
  supportedStravaScopes,
} from "./config";
import { revokeStravaTokenWithRetry } from "./tokenRevocation";

const FETCH_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_SKEW_MS = 60 * 60 * 1000;
const MIN_OAUTH_ARTIFACT_LENGTH = 16;
const MAX_OAUTH_CODE_LENGTH = 4096;
const MAX_OAUTH_STATE_LENGTH = 1024;
const MAX_OAUTH_TICKET_LENGTH = 256;
const MAX_CALLBACK_SCOPES = 10;

const accessTokenCandidateSchema = z.object({ access_token: z.string().min(1) }).passthrough();
const tokenScopeSchema = z.object({ scope: z.string().optional() }).passthrough();

export interface ParsedStravaInitialTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  athleteId: string;
  scopes: string[];
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export async function hashOAuthArtifact(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}

function generateOpaqueValue(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function hasBoundedArtifactLength(value: string, maxLength: number): boolean {
  return value.length >= MIN_OAUTH_ARTIFACT_LENGTH && value.length <= maxLength;
}

export function parseStravaCallbackScopes(raw: string): string[] {
  const scopes = raw
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length > MAX_CALLBACK_SCOPES) return [];
  return supportedStravaScopes(scopes);
}

export function buildStravaAuthorizeUrl(config: StravaAppConfig, state: string): string {
  const url = new URL(STRAVA_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("approval_prompt", "auto");
  url.searchParams.set("scope", STRAVA_REQUIRED_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

export function parseInitialTokenResponse(
  raw: unknown,
  acceptedScopes: readonly string[],
  now: number,
): ParsedStravaInitialTokenResponse {
  const scopeResult = tokenScopeSchema.safeParse(raw);
  if (!scopeResult.success) {
    throw new Error("Malformed Strava OAuth token response");
  }
  const parsed = parseInitialStravaTokenResponse(raw, now);
  const callbackScopes = supportedStravaScopes(acceptedScopes);
  const tokenScopes = scopeResult.data.scope
    ? supportedStravaScopes(scopeResult.data.scope.split(/[\s,]+/))
    : callbackScopes;
  if (
    !callbackScopes.includes(STRAVA_REQUIRED_SCOPE) ||
    !tokenScopes.includes(STRAVA_REQUIRED_SCOPE)
  ) {
    throw new Error("Strava did not grant activity read access");
  }
  return {
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.tokenExpiresAt,
    athleteId: parsed.athleteId,
    scopes: tokenScopes,
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

export type StartStravaOAuthResult =
  { success: true; authorizeUrl: string } | { success: false; error: string };

export const startStravaOAuth = action({
  args: {},
  handler: async (ctx): Promise<StartStravaOAuthResult> => {
    if (!isStravaConfigured()) {
      return { success: false, error: "Strava integration is not available on this deployment." };
    }
    const userId: Id<"users"> | null = await ctx.runQuery(
      internal.lib.auth.resolveEffectiveUserId,
      {},
    );
    if (!userId) return { success: false, error: "Not authenticated" };
    const alreadyConnected: boolean = await ctx.runQuery(
      internal.strava.status.hasActiveConnectionByUserId,
      { userId },
    );
    if (alreadyConnected) {
      return { success: false, error: "Disconnect Strava before connecting another account." };
    }
    try {
      await rateLimiter.limit(ctx, "startStravaOAuth", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) {
        return {
          success: false,
          error: "Too many Strava connection attempts. Please wait a minute and try again.",
        };
      }
      return { success: false, error: "Unable to start Strava connection right now." };
    }

    try {
      const state = generateOpaqueValue();
      await ctx.runMutation(internal.strava.oauthArtifacts.saveOauthState, {
        userId,
        stateHash: await hashOAuthArtifact(state),
        now: Date.now(),
      });
      return {
        success: true,
        authorizeUrl: buildStravaAuthorizeUrl(getStravaAppConfig(), state),
      };
    } catch {
      console.error("[stravaOAuth] failed to start OAuth", { userId });
      return { success: false, error: "Failed to start Strava OAuth. Please try again." };
    }
  },
});

export type IssueStravaCallbackTicketResult =
  { success: true; ticket: string } | { success: false };

export const issueStravaCallbackTicket = internalAction({
  args: { code: v.string(), state: v.string(), acceptedScopes: v.array(v.string()) },
  handler: async (ctx, args): Promise<IssueStravaCallbackTicketResult> => {
    if (
      !isStravaConfigured() ||
      !hasBoundedArtifactLength(args.code, MAX_OAUTH_CODE_LENGTH) ||
      !hasBoundedArtifactLength(args.state, MAX_OAUTH_STATE_LENGTH) ||
      args.acceptedScopes.length > MAX_CALLBACK_SCOPES ||
      !supportedStravaScopes(args.acceptedScopes).includes(STRAVA_REQUIRED_SCOPE)
    ) {
      return { success: false };
    }
    try {
      const ticket = generateOpaqueValue();
      const stored: boolean = await ctx.runMutation(
        internal.strava.oauthArtifacts.exchangeOauthStateForTicket,
        {
          stateHash: await hashOAuthArtifact(args.state),
          ticketHash: await hashOAuthArtifact(ticket),
          authorizationCodeEncrypted: await encryptStravaSecret(args.code),
          acceptedScopes: supportedStravaScopes(args.acceptedScopes),
          now: Date.now(),
        },
      );
      return stored ? { success: true, ticket } : { success: false };
    } catch {
      console.error("[stravaOAuth] failed to issue callback ticket");
      return { success: false };
    }
  },
});

export type CompleteStravaOAuthResult = { success: true } | { success: false; error: string };

export const completeStravaOAuth = action({
  args: { ticket: v.string() },
  handler: async (ctx, { ticket }): Promise<CompleteStravaOAuthResult> => {
    if (!isStravaConfigured()) {
      return { success: false, error: "Strava integration is not available on this deployment." };
    }
    if (!hasBoundedArtifactLength(ticket, MAX_OAUTH_TICKET_LENGTH)) {
      return { success: false, error: "Invalid or expired Strava callback ticket" };
    }
    const userId: Id<"users"> | null = await ctx.runQuery(
      internal.lib.auth.resolveEffectiveUserId,
      {},
    );
    if (!userId) return { success: false, error: "Not authenticated" };
    const alreadyConnected: boolean = await ctx.runQuery(
      internal.strava.status.hasActiveConnectionByUserId,
      { userId },
    );
    if (alreadyConnected) {
      return { success: false, error: "Disconnect Strava before connecting another account." };
    }
    try {
      await rateLimiter.limit(ctx, "completeStravaOAuth", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) {
        return { success: false, error: "Too many Strava completion attempts. Try again later." };
      }
      return { success: false, error: "Unable to complete Strava connection right now." };
    }

    const now = Date.now();
    const ticketHash = await hashOAuthArtifact(ticket);
    const completionNonce = generateOpaqueValue();
    const claim = await ctx.runMutation(internal.strava.oauthArtifacts.claimOauthCallbackTicket, {
      userId,
      ticketHash,
      completionNonce,
      now,
    });
    if (!claim) {
      return { success: false, error: "Invalid or expired Strava callback ticket" };
    }
    if (claim.state === "active") {
      return { success: false, error: "Disconnect Strava before connecting another account." };
    }
    const artifact = claim.artifact;

    try {
      let accessTokenToRevoke: string | null = null;
      let connectionPersisted = false;
      try {
        const config = getStravaAppConfig();
        const tokenResponse = await fetch(STRAVA_TOKEN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code: await decryptStravaSecret(artifact.authorizationCodeEncrypted),
            grant_type: "authorization_code",
          }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const rawTokens = await responseJson(tokenResponse, "Strava OAuth token exchange failed");
        const accessTokenCandidate = accessTokenCandidateSchema.safeParse(rawTokens);
        if (accessTokenCandidate.success) {
          accessTokenToRevoke = accessTokenCandidate.data.access_token;
        }
        const tokens = parseInitialTokenResponse(rawTokens, artifact.acceptedScopes, now);
        const generation = generateOpaqueValue();

        await ctx.runMutation(internal.strava.connections.upsertActiveConnection, {
          userId,
          athleteId: tokens.athleteId,
          generation,
          accessTokenEncrypted: await encryptStravaSecret(tokens.accessToken),
          refreshTokenEncrypted: await encryptStravaSecret(tokens.refreshToken),
          tokenExpiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
          refreshDueAt: Math.max(now, tokens.expiresAt - TOKEN_REFRESH_SKEW_MS),
          now,
        });
        connectionPersisted = true;
        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const duplicateAthlete =
          message === "This Strava account is already connected to another Roni account" ||
          message === "This Strava account is already connected to your Roni account";
        const connectionConflict =
          duplicateAthlete ||
          message === "Disconnect your current Strava account before connecting another";
        if (accessTokenToRevoke && !connectionPersisted && !duplicateAthlete) {
          const revoked = await revokeStravaTokenWithRetry(accessTokenToRevoke).catch(() => false);
          if (!revoked) {
            console.error("[stravaOAuth] failed to revoke an unpersisted OAuth token", { userId });
          }
        }
        if (connectionConflict) {
          return { success: false, error: message };
        }
        console.error("[stravaOAuth] failed to complete OAuth", { userId });
        return { success: false, error: "Failed to complete Strava OAuth. Please try again." };
      }
    } finally {
      await ctx
        .runMutation(internal.strava.oauthArtifacts.releaseOauthCallbackTicket, {
          userId,
          ticketHash,
          completionNonce,
        })
        .catch(() => false);
    }
  },
});

export const sweepExpiredOauthArtifacts = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const result: { deleted: number; hasMore: boolean } = await ctx.runMutation(
      internal.strava.oauthArtifacts.sweepExpired,
      { now: Date.now() },
    );
    if (result.hasMore) {
      await ctx.scheduler.runAfter(0, internal.strava.oauthFlow.sweepExpiredOauthArtifacts, {});
    }
    return result.deleted;
  },
});
