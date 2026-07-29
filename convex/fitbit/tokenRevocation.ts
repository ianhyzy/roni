import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { decryptFitbitSecret, FITBIT_REVOKE_URL } from "./config";

const REVOKE_TIMEOUT_MS = 10_000;
const REVOKE_MAX_ATTEMPTS = 3;
const REVOKE_BASE_BACKOFF_MS = 250;
const REVOKE_MAX_BACKOFF_MS = 5_000;

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
type Sleeper = (delayMs: number) => Promise<void>;
type Revoker = (token: string) => Promise<boolean>;

interface RevokeRetryOptions {
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

function revokeRetryDelayMs(
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

export async function revokeFitbitTokenWithRetry(
  token: string,
  fetcherOrOptions: Fetcher | RevokeRetryOptions = {},
): Promise<boolean> {
  const options =
    typeof fetcherOrOptions === "function" ? { fetcher: fetcherOrOptions } : fetcherOrOptions;
  const { fetcher = fetch, now = Date.now, random = Math.random, sleep: wait = sleep } = options;
  for (let attempt = 1; attempt <= REVOKE_MAX_ATTEMPTS; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetcher(FITBIT_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
      });
      if (response.ok || response.status === 400) return true;
      if (response.status < 500 && response.status !== 408 && response.status !== 429) return false;
    } catch {
      // Retry transient network failures without logging credentials or bodies.
    }
    if (attempt < REVOKE_MAX_ATTEMPTS) {
      await wait(revokeRetryDelayMs(attempt, response, random, now));
    }
  }
  return false;
}

export async function revokeEncryptedFitbitToken(refreshTokenEncrypted: string): Promise<boolean> {
  try {
    return await revokeFitbitTokenWithRetry(await decryptFitbitSecret(refreshTokenEncrypted));
  } catch {
    return false;
  }
}

export async function resolveLostFitbitTokenRefresh(
  ctx: Pick<ActionCtx, "runQuery">,
  {
    userId,
    generation,
    discardedRefreshToken,
    revoke = revokeFitbitTokenWithRetry,
  }: {
    userId: Id<"users">;
    generation: string;
    discardedRefreshToken: string;
    revoke?: Revoker;
  },
): Promise<string> {
  const latest = await ctx.runQuery(internal.fitbit.connections.getConnectionByUserId, { userId });
  if (latest?.status === "active" && latest.generation === generation) {
    return decryptFitbitSecret(latest.accessTokenEncrypted);
  }
  if (!latest || latest.generation === generation) {
    const revoked = await revoke(discardedRefreshToken);
    if (!revoked) {
      console.error("[fitbitSync] failed to revoke a discarded rotated token", {
        userId,
        generation,
      });
    }
  }
  throw new Error("Fitbit connection changed during sync");
}
