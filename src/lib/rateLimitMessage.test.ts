import { type RateLimitError } from "@convex-dev/rate-limiter";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { describeError, getRateLimitMessage } from "./rateLimitMessage";

// Verbatim shape of what reached a user's toast before this existed.
const REAL_RATE_LIMIT_ERROR = new Error(
  "[CONVEX M(exerciseExclusions:addMine)] [Request ID: 428afe7169a43b04] Server Error\n" +
    'Uncaught ConvexError: Uncaught ConvexError: {"kind":"RateLimited","name":"addExerciseExclusion","retryAfter":1658}\n' +
    "    at checkRateLimitOrThrow (../../node_modules/@convex-dev/rate-limiter/src/component/internal.ts:22:6)",
);

describe("getRateLimitMessage", () => {
  it("uses structured Convex error data when its message omits the payload", () => {
    const error = new ConvexError({
      kind: "RateLimited",
      name: "addExerciseExclusion",
      retryAfter: 1_658,
    } satisfies RateLimitError);
    error.message = "Request failed";

    expect(getRateLimitMessage(error)).toBe("Going a bit fast — try again in 2s.");
  });

  it("turns a Convex rate-limit rejection into a wait message", () => {
    expect(getRateLimitMessage(REAL_RATE_LIMIT_ERROR)).toBe("Going a bit fast — try again in 2s.");
  });

  it("rounds a long wait up to minutes", () => {
    const error = new Error('ConvexError: {"kind":"RateLimited","retryAfter":95000}');

    expect(getRateLimitMessage(error)).toBe("Going a bit fast — try again in about 2 minutes.");
  });

  it("still advises waiting when retryAfter is absent", () => {
    const error = new Error('ConvexError: {"kind":"RateLimited","name":"addExerciseExclusion"}');

    expect(getRateLimitMessage(error)).toBe("Going a bit fast — wait a moment and try again.");
  });

  it("returns null for unrelated errors so the caller can show its own copy", () => {
    expect(getRateLimitMessage(new Error("Movement not found"))).toBeNull();
    expect(getRateLimitMessage("not an error")).toBeNull();
  });
});

describe("describeError", () => {
  it("keeps a useful server message and drops the Convex wrapper and stack", () => {
    const error = new Error(
      "Uncaught Error: Movement not found at handler (../convex/exerciseExclusions.ts:80:13)",
    );

    expect(describeError(error, "fallback")).toBe("Movement not found");
  });

  it("strips doubled ConvexError prefixes", () => {
    const error = new Error("Uncaught ConvexError: Uncaught ConvexError: Maximum 100 exclusions");

    expect(describeError(error, "fallback")).toBe("Maximum 100 exclusions");
  });

  it("falls back rather than showing a raw JSON payload", () => {
    expect(describeError(REAL_RATE_LIMIT_ERROR, "Could not exclude exercise")).toBe(
      "Could not exclude exercise",
    );
  });

  it("falls back for non-Error throws", () => {
    expect(describeError({ nope: true }, "Could not exclude exercise")).toBe(
      "Could not exclude exercise",
    );
  });
});
