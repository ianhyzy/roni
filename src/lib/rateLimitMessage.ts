import { isRateLimitError } from "@convex-dev/rate-limiter";

/**
 * Convex rate-limit rejections normally reach the client as a structured
 * ConvexError. Older transports can instead embed the payload in the message:
 *
 *   Uncaught ConvexError: {"kind":"RateLimited","name":"addExerciseExclusion","retryAfter":1658}
 *     at checkRateLimitOrThrow (...)
 *
 * Surfacing that verbatim in a toast is how users end up reading stack traces.
 */

const RATE_LIMITED_MARKER = '"kind":"RateLimited"';
const RETRY_AFTER_PATTERN = /"retryAfter":\s*(\d+(?:\.\d+)?)/;

/**
 * A short, human wait message when `error` is a Convex rate-limit rejection,
 * or null when it is any other kind of error.
 */
export function getRateLimitMessage(error: unknown): string | null {
  let retryAfterMs: number;
  if (isRateLimitError(error)) {
    retryAfterMs = error.data.retryAfter;
  } else {
    const raw = error instanceof Error ? error.message : "";
    if (!raw.includes(RATE_LIMITED_MARKER)) return null;

    retryAfterMs = Number(RETRY_AFTER_PATTERN.exec(raw)?.[1]);
  }
  if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return "Going a bit fast — wait a moment and try again.";
  }

  const seconds = Math.ceil(retryAfterMs / 1000);
  if (seconds >= 60) {
    const minutes = Math.ceil(seconds / 60);
    return `Going a bit fast — try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  return `Going a bit fast — try again in ${Math.max(1, seconds)}s.`;
}

const ERROR_PREFIX = /^\s*(uncaught\s+)?(convex)?error:\s*/i;
const TRAILING_STACK = /\s+at\s+\S+\s*\(.*$/;

/**
 * The first useful line of a thrown error, with Convex's `Uncaught ConvexError:`
 * prefixes and server stack frames stripped. Server-side `throw new Error(...)`
 * messages ("Movement not found") are worth showing; the wrapper around them
 * is not.
 */
export function describeError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;

  for (const line of error.message.split("\n")) {
    // Convex prefixes every server failure with a `[CONVEX M(fn)] ... Server
    // Error` header and suffixes it with stack frames; neither is user copy.
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("[CONVEX") || trimmed.startsWith("at ")) continue;

    let message = trimmed;
    let previous: string;
    do {
      previous = message;
      message = message.replace(ERROR_PREFIX, "");
    } while (message !== previous);

    const cleaned = message.replace(TRAILING_STACK, "").trim();
    // A bare JSON payload is machine detail, not something to show a user.
    if (!cleaned || cleaned.startsWith("{")) continue;
    return cleaned;
  }

  return fallback;
}
