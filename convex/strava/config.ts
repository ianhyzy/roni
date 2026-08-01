import { decrypt, encrypt } from "../tonal/encryption";

export const STRAVA_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
export const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
export const STRAVA_REVOKE_URL = "https://www.strava.com/oauth/revoke";
export const STRAVA_API_BASE_URL = "https://api-v3.strava.com";
export const STRAVA_REQUIRED_SCOPE = "activity:read" as const;

export type StravaScope = typeof STRAVA_REQUIRED_SCOPE;

export interface StravaAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface StravaWebhookConfig {
  verifyToken: string;
  subscriptionId: string;
  signingSecret: string;
}

export function supportedStravaScopes(scopes: readonly string[]): StravaScope[] {
  return scopes.includes(STRAVA_REQUIRED_SCOPE) ? [STRAVA_REQUIRED_SCOPE] : [];
}

export function isStravaConfigured(): boolean {
  return Boolean(
    process.env.STRAVA_CLIENT_ID &&
    process.env.STRAVA_CLIENT_SECRET &&
    process.env.STRAVA_OAUTH_CALLBACK_URL &&
    process.env.TOKEN_ENCRYPTION_KEY,
  );
}

export function isStravaFeatureConfigured(): boolean {
  if (!isStravaConfigured()) return false;
  try {
    getStravaWebhookConfig();
    return true;
  } catch {
    return false;
  }
}

export function getStravaAppConfig(): StravaAppConfig {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const redirectUri = process.env.STRAVA_OAUTH_CALLBACK_URL;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Strava is not configured: set STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_OAUTH_CALLBACK_URL",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export function getStravaWebhookConfig(): StravaWebhookConfig {
  const verifyToken = process.env.STRAVA_WEBHOOK_VERIFY_TOKEN?.trim();
  const subscriptionId = process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID?.trim();
  const signingSecret = process.env.STRAVA_WEBHOOK_SIGNING_SECRET?.trim();
  if (
    !verifyToken ||
    verifyToken.length < 16 ||
    !subscriptionId ||
    !/^\d+$/.test(subscriptionId) ||
    !signingSecret ||
    signingSecret.length < 16
  ) {
    throw new Error("Strava webhook is not configured");
  }
  return { verifyToken, subscriptionId, signingSecret };
}

function getEncryptionKey(): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY env var is not set");
  return key;
}

export async function encryptStravaSecret(plaintext: string): Promise<string> {
  return encrypt(plaintext, getEncryptionKey());
}

export async function decryptStravaSecret(ciphertext: string): Promise<string> {
  return decrypt(ciphertext, getEncryptionKey());
}
