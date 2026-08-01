import { decryptStravaSecret, getStravaAppConfig, STRAVA_REVOKE_URL } from "./config";

const REVOKE_TIMEOUT_MS = 10_000;
const REVOKE_MAX_ATTEMPTS = 3;
const REVOKE_BASE_BACKOFF_MS = 250;
const REVOKE_MAX_BACKOFF_MS = 5_000;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type Sleeper = (delayMs: number) => Promise<void>;

export interface RevokeRetryOptions {
  fetcher?: Fetcher;
  now?: () => number;
  random?: () => number;
  sleep?: Sleeper;
}

function retryAfterMs(response: Response, now: number): number | null {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : null;
}

function retryDelayMs(
  attempt: number,
  response: Response | undefined,
  random: () => number,
  now: () => number,
): number {
  const exponential = Math.min(REVOKE_MAX_BACKOFF_MS, REVOKE_BASE_BACKOFF_MS * 2 ** (attempt - 1));
  const jittered = exponential / 2 + random() * (exponential / 2);
  const requested = response ? retryAfterMs(response, now()) : null;
  return Math.min(REVOKE_MAX_BACKOFF_MS, Math.max(Math.round(jittered), requested ?? 0));
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function basicClientAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
}

export async function revokeStravaTokenWithRetry(
  accessToken: string,
  options: RevokeRetryOptions = {},
): Promise<boolean> {
  const config = getStravaAppConfig();
  const { fetcher = fetch, now = Date.now, random = Math.random, sleep: wait = sleep } = options;
  for (let attempt = 1; attempt <= REVOKE_MAX_ATTEMPTS; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetcher(STRAVA_REVOKE_URL, {
        method: "POST",
        headers: {
          Authorization: basicClientAuthorization(config.clientId, config.clientSecret),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token: accessToken }),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      if (response.ok) return true;
      if (response.status < 500 && response.status !== 408 && response.status !== 429) return false;
    } catch {
      // Retry transient network failures without logging credentials or bodies.
    }
    if (attempt < REVOKE_MAX_ATTEMPTS) {
      await wait(retryDelayMs(attempt, response, random, now));
    }
  }
  return false;
}

export async function revokeEncryptedStravaToken(
  accessTokenEncrypted: string,
  options: RevokeRetryOptions = {},
): Promise<boolean> {
  try {
    return await revokeStravaTokenWithRetry(
      await decryptStravaSecret(accessTokenEncrypted),
      options,
    );
  } catch {
    return false;
  }
}
