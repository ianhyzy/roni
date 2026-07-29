import { isRateLimitError } from "@convex-dev/rate-limiter";
import { v } from "convex/values";
import { z } from "zod";
import { internal } from "../_generated/api";
import { action, internalAction } from "../_generated/server";
import { rateLimiter } from "../rateLimits";
import {
  decryptFitbitSecret,
  encryptFitbitSecret,
  FITBIT_AUTHORIZE_URL,
  FITBIT_READ_SCOPES,
  FITBIT_TOKEN_URL,
  type FitbitAppConfig,
  getFitbitAppConfig,
  GOOGLE_HEALTH_API_BASE_URL,
  isFitbitConfigured,
  supportedFitbitScopes,
} from "./config";
import { revokeFitbitTokenWithRetry } from "./tokenRevocation";

const FETCH_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_SYNC_DAYS = 30;
const MIN_OAUTH_ARTIFACT_LENGTH = 16;
const MAX_OAUTH_CODE_LENGTH = 4096;
const MAX_OAUTH_STATE_LENGTH = 1024;
const MAX_OAUTH_TICKET_LENGTH = 256;
const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1),
    expires_in: z.number().finite().positive(),
    token_type: z.string().min(1),
    scope: z.string().min(1),
  })
  .passthrough();
const identityResponseSchema = z.object({ healthUserId: z.string().min(1) });
const refreshTokenCandidateSchema = z.object({ refresh_token: z.string().min(1) }).passthrough();

export interface ParsedInitialTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scopes: string[];
}

export function parseInitialTokenResponse(raw: unknown): ParsedInitialTokenResponse {
  const parsed = tokenResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new Error("Malformed Google OAuth token response");
  }
  const scopes = supportedFitbitScopes(parsed.data.scope.split(/\s+/));
  if (scopes.length === 0) {
    throw new Error("Google OAuth did not grant a supported Fitbit read scope");
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresInSeconds: parsed.data.expires_in,
    scopes,
  };
}

export function parseIdentityResponse(raw: unknown): z.infer<typeof identityResponseSchema> {
  const parsed = identityResponseSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Malformed Google Health identity response");
  return parsed.data;
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

export const hashOAuthState = hashOAuthArtifact;

function generateOpaqueValue(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function hasBoundedArtifactLength(value: string, maxLength: number): boolean {
  return value.length >= MIN_OAUTH_ARTIFACT_LENGTH && value.length <= maxLength;
}

export function buildFitbitAuthorizeUrl(config: FitbitAppConfig, state: string): string {
  const url = new URL(FITBIT_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", FITBIT_READ_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return url.toString();
}

async function responseJson(response: Response, errorMessage: string): Promise<unknown> {
  if (!response.ok) throw new Error(`${errorMessage}: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${errorMessage}: malformed JSON`);
  }
}

export type StartFitbitOAuthResult =
  { success: true; authorizeUrl: string } | { success: false; error: string };

export const startFitbitOAuth = action({
  args: {},
  handler: async (ctx): Promise<StartFitbitOAuthResult> => {
    if (!isFitbitConfigured()) {
      return { success: false, error: "Fitbit integration is not available on this deployment." };
    }
    const userId = await ctx.runQuery(internal.lib.auth.resolveEffectiveUserId, {});
    if (!userId) return { success: false, error: "Not authenticated" };

    try {
      await rateLimiter.limit(ctx, "startFitbitOAuth", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) {
        return {
          success: false,
          error: "Too many Fitbit connection attempts. Please wait a minute and try again.",
        };
      }
      console.error("[fitbitOAuth] failed to acquire start slot", { userId });
      return { success: false, error: "Unable to start Fitbit connection right now." };
    }

    try {
      const state = generateOpaqueValue();
      await ctx.runMutation(internal.fitbit.oauthArtifacts.saveOauthState, {
        userId,
        stateHash: await hashOAuthArtifact(state),
        now: Date.now(),
      });
      return {
        success: true,
        authorizeUrl: buildFitbitAuthorizeUrl(getFitbitAppConfig(), state),
      };
    } catch {
      console.error("[fitbitOAuth] failed to start OAuth", { userId });
      return { success: false, error: "Failed to start Fitbit OAuth. Please try again." };
    }
  },
});

export type IssueFitbitCallbackTicketResult =
  { success: true; ticket: string } | { success: false };

export const issueFitbitCallbackTicket = internalAction({
  args: { code: v.string(), state: v.string() },
  handler: async (ctx, { code, state }): Promise<IssueFitbitCallbackTicketResult> => {
    if (
      !isFitbitConfigured() ||
      !hasBoundedArtifactLength(code, MAX_OAUTH_CODE_LENGTH) ||
      !hasBoundedArtifactLength(state, MAX_OAUTH_STATE_LENGTH)
    ) {
      return { success: false };
    }
    try {
      const ticket = generateOpaqueValue();
      const stored: boolean = await ctx.runMutation(
        internal.fitbit.oauthArtifacts.exchangeOauthStateForTicket,
        {
          stateHash: await hashOAuthArtifact(state),
          ticketHash: await hashOAuthArtifact(ticket),
          authorizationCodeEncrypted: await encryptFitbitSecret(code),
          now: Date.now(),
        },
      );
      return stored ? { success: true, ticket } : { success: false };
    } catch {
      console.error("[fitbitOAuth] failed to issue callback ticket");
      return { success: false };
    }
  },
});

export type CompleteFitbitOAuthResult = { success: true } | { success: false; error: string };

export const completeFitbitOAuth = action({
  args: { ticket: v.string() },
  handler: async (ctx, { ticket }): Promise<CompleteFitbitOAuthResult> => {
    if (!isFitbitConfigured()) {
      return { success: false, error: "Fitbit integration is not available on this deployment." };
    }
    if (!hasBoundedArtifactLength(ticket, MAX_OAUTH_TICKET_LENGTH)) {
      return { success: false, error: "Invalid or expired Fitbit callback ticket" };
    }
    const userId = await ctx.runQuery(internal.lib.auth.resolveEffectiveUserId, {});
    if (!userId) return { success: false, error: "Not authenticated" };
    try {
      await rateLimiter.limit(ctx, "completeFitbitOAuth", { key: userId, throws: true });
    } catch (error) {
      if (isRateLimitError(error)) {
        return { success: false, error: "Too many Fitbit completion attempts. Try again later." };
      }
      return { success: false, error: "Unable to complete Fitbit connection right now." };
    }

    const now = Date.now();
    const encryptedCode = await ctx.runMutation(
      internal.fitbit.oauthArtifacts.claimOauthCallbackTicket,
      { userId, ticketHash: await hashOAuthArtifact(ticket), now },
    );
    if (!encryptedCode) {
      return { success: false, error: "Invalid or expired Fitbit callback ticket" };
    }

    let refreshTokenToRevoke: string | null = null;
    let connectionPersisted = false;
    try {
      const config = getFitbitAppConfig();
      const tokenResponse = await fetch(FITBIT_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: await decryptFitbitSecret(encryptedCode),
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.redirectUri,
          grant_type: "authorization_code",
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const rawTokens = await responseJson(tokenResponse, "Google OAuth token exchange failed");
      const refreshTokenCandidate = refreshTokenCandidateSchema.safeParse(rawTokens);
      if (refreshTokenCandidate.success) {
        refreshTokenToRevoke = refreshTokenCandidate.data.refresh_token;
      }
      const tokens = parseInitialTokenResponse(rawTokens);

      const identityResponse = await fetch(`${GOOGLE_HEALTH_API_BASE_URL}/users/me/identity`, {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const identity = parseIdentityResponse(
        await responseJson(identityResponse, "Google Health identity request failed"),
      );
      const generation = generateOpaqueValue();
      const tokenExpiresAt = now + tokens.expiresInSeconds * 1000;
      const refreshDueAt = Math.max(
        now,
        Math.min(now + SYNC_INTERVAL_MS, tokenExpiresAt - TOKEN_REFRESH_SKEW_MS),
      );

      await ctx.runMutation(internal.fitbit.connections.upsertActiveConnection, {
        userId,
        healthUserId: identity.healthUserId,
        generation,
        accessTokenEncrypted: await encryptFitbitSecret(tokens.accessToken),
        refreshTokenEncrypted: await encryptFitbitSecret(tokens.refreshToken),
        tokenExpiresAt,
        scopes: tokens.scopes,
        refreshDueAt,
        now,
      });
      connectionPersisted = true;
      await ctx.scheduler.runAfter(0, internal.fitbit.sync.syncConnection, {
        userId,
        generation,
        days: INITIAL_SYNC_DAYS,
      });
      return { success: true };
    } catch (error) {
      if (refreshTokenToRevoke && !connectionPersisted) {
        try {
          const revoked = await revokeFitbitTokenWithRetry(refreshTokenToRevoke);
          if (!revoked) {
            console.error("[fitbitOAuth] failed to revoke an unpersisted OAuth token", { userId });
          }
        } catch {
          console.error("[fitbitOAuth] failed to revoke an unpersisted OAuth token", { userId });
        }
      }
      const message = error instanceof Error ? error.message : "";
      if (message === "This Fitbit account is already connected to another Roni account") {
        return { success: false, error: message };
      }
      console.error("[fitbitOAuth] failed to complete OAuth", { userId });
      return { success: false, error: "Failed to complete Fitbit OAuth. Please try again." };
    }
  },
});
