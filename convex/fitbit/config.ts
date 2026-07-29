import { decrypt, encrypt } from "../tonal/encryption";

export const FITBIT_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const FITBIT_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const FITBIT_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_HEALTH_API_BASE_URL = "https://health.googleapis.com/v4";

export const FITBIT_READ_SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
] as const;

export type FitbitReadScope = (typeof FITBIT_READ_SCOPES)[number];

const fitbitReadScopeSet = new Set<string>(FITBIT_READ_SCOPES);

/** Keep only the supported read scopes so status never exposes unrelated grants. */
export function supportedFitbitScopes(scopes: readonly string[]): FitbitReadScope[] {
  return [...new Set(scopes)].filter((scope): scope is FitbitReadScope =>
    fitbitReadScopeSet.has(scope),
  );
}

export interface FitbitAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function isFitbitConfigured(): boolean {
  return Boolean(
    process.env.FITBIT_GOOGLE_CLIENT_ID &&
    process.env.FITBIT_GOOGLE_CLIENT_SECRET &&
    process.env.FITBIT_GOOGLE_OAUTH_CALLBACK_URL &&
    process.env.TOKEN_ENCRYPTION_KEY,
  );
}

export function getFitbitAppConfig(): FitbitAppConfig {
  const clientId = process.env.FITBIT_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.FITBIT_GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.FITBIT_GOOGLE_OAUTH_CALLBACK_URL;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Fitbit is not configured: set FITBIT_GOOGLE_CLIENT_ID, FITBIT_GOOGLE_CLIENT_SECRET, FITBIT_GOOGLE_OAUTH_CALLBACK_URL",
    );
  }
  return { clientId, clientSecret, redirectUri };
}

function getEncryptionKey(): string {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY env var is not set");
  return key;
}

export async function encryptFitbitSecret(plaintext: string): Promise<string> {
  return encrypt(plaintext, getEncryptionKey());
}

export async function decryptFitbitSecret(ciphertext: string): Promise<string> {
  return decrypt(ciphertext, getEncryptionKey());
}
