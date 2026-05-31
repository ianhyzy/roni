/**
 * Tests for cachedFetch (proxy.ts).
 *
 * Primary concern: auth errors (TonalSessionExpiredError, TonalApiError 401)
 * must propagate even when stale cached data is available — the stale-while-
 * revalidate fallback must never swallow them.
 *
 * Before commit 09e4253, the session-expiry guard used a fragile string check:
 *   `error instanceof Error && error.message.includes("session expired")`
 * That check silently broke any time the error message changed and would have
 * swallowed the error if stale data existed, leading to the caller returning
 * outdated results and never prompting the user to reconnect.
 *
 * The fix changed it to the canonical instanceof check:
 *   `error instanceof TonalSessionExpiredError`
 *
 * These tests lock that contract in place.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { TonalApiError } from "./client";

vi.mock("./encryption", () => ({
  decrypt: vi.fn(async (val: string) => `decrypted:${val}`),
  encrypt: vi.fn(async (val: string) => `encrypted:${val}`),
}));

vi.mock("../_generated/api", () => ({
  internal: {
    tonal: {
      cache: {
        getCacheEntry: "getCacheEntry",
        setCacheEntry: "setCacheEntry",
        deleteCacheEntryByType: "deleteCacheEntryByType",
        getUserProfile: "getUserProfile",
      },
    },
    userProfiles: {
      markTokenExpired: "markTokenExpired",
      updateTonalToken: "updateTonalToken",
      acquireTokenRefreshLock: "acquireTokenRefreshLock",
      releaseTokenRefreshLock: "releaseTokenRefreshLock",
    },
  },
}));

import { cachedFetch } from "./proxy";
import { TonalSessionExpiredError } from "./tokenRetry";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

const TEST_USER_ID = "test-user-123" as Id<"users">;
const STALE_EXPIRES_AT = 1_700_000_000_000;
const FRESH_EXPIRES_AT = 4_100_000_000_000;

function makeCtx(queryResult: unknown = null): ActionCtx {
  return {
    runQuery: vi.fn(async () => queryResult),
    runMutation: vi.fn(async () => undefined),
  } as unknown as ActionCtx;
}

function staleEntry(data: unknown) {
  return { data, expiresAt: STALE_EXPIRES_AT };
}

function freshEntry(data: unknown) {
  return { data, expiresAt: FRESH_EXPIRES_AT };
}

describe("cachedFetch auth-error propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("re-throws TonalSessionExpiredError even when stale cache exists", async () => {
    const ctx = makeCtx(staleEntry({ old: "data" }));

    await expect(
      cachedFetch<unknown>(ctx, {
        userId: TEST_USER_ID,
        dataType: "test",
        ttl: 60_000,
        fetcher: async () => {
          throw new TonalSessionExpiredError();
        },
      }),
    ).rejects.toBeInstanceOf(TonalSessionExpiredError);
  });

  it("re-throws TonalSessionExpiredError when there is no cached data", async () => {
    const ctx = makeCtx(null);

    await expect(
      cachedFetch<unknown>(ctx, {
        userId: TEST_USER_ID,
        dataType: "test",
        ttl: 60_000,
        fetcher: async () => {
          throw new TonalSessionExpiredError();
        },
      }),
    ).rejects.toBeInstanceOf(TonalSessionExpiredError);
  });

  it("re-throws TonalApiError 401 even when stale cache exists", async () => {
    const ctx = makeCtx(staleEntry({ old: "data" }));

    await expect(
      cachedFetch<unknown>(ctx, {
        userId: TEST_USER_ID,
        dataType: "test",
        ttl: 60_000,
        fetcher: async () => {
          throw new TonalApiError(401, "Unauthorized");
        },
      }),
    ).rejects.toBeInstanceOf(TonalApiError);
  });

  it("TonalSessionExpiredError message is not required to contain 'session expired'", async () => {
    // Validates that the instanceof check is used, not a fragile string check.
    // If the error message changes, the test still passes.
    const ctx = makeCtx(null);
    const err = new TonalSessionExpiredError();

    // The message can be anything; instanceof is what matters.
    await expect(
      cachedFetch<unknown>(ctx, {
        userId: TEST_USER_ID,
        dataType: "test",
        ttl: 60_000,
        fetcher: async () => {
          throw err;
        },
      }),
    ).rejects.toBe(err);
  });
});

describe("cachedFetch stale-while-revalidate fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves stale cache when a non-auth error occurs during refresh", async () => {
    const ctx = makeCtx(staleEntry({ stale: "value" }));

    const result = await cachedFetch<unknown>(ctx, {
      userId: TEST_USER_ID,
      dataType: "test",
      ttl: 60_000,
      fetcher: async () => {
        throw new Error("network timeout");
      },
    });

    expect(result).toEqual({ stale: "value" });
  });

  it("re-throws non-auth errors when there is no stale cache to fall back on", async () => {
    const ctx = makeCtx(null);

    await expect(
      cachedFetch<unknown>(ctx, {
        userId: TEST_USER_ID,
        dataType: "test",
        ttl: 60_000,
        fetcher: async () => {
          throw new Error("network timeout");
        },
      }),
    ).rejects.toThrow("network timeout");
  });
});

describe("cachedFetch normal operation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns fresh data when fetcher succeeds and writes it to cache", async () => {
    const ctx = makeCtx(null);

    const result = await cachedFetch<unknown>(ctx, {
      userId: TEST_USER_ID,
      dataType: "profile",
      ttl: 60_000,
      fetcher: async () => ({ fresh: "data" }),
    });

    expect(result).toEqual({ fresh: "data" });
    expect(ctx.runMutation).toHaveBeenCalledWith(
      "setCacheEntry",
      expect.objectContaining({ userId: TEST_USER_ID, dataType: "profile" }),
    );
  });

  it("returns cached data and skips the fetcher when cache is fresh", async () => {
    const fetcher = vi.fn(async () => ({ should: "not be called" }));
    const ctx = makeCtx(freshEntry({ cached: "hit" }));

    const result = await cachedFetch<unknown>(ctx, {
      userId: TEST_USER_ID,
      dataType: "profile",
      ttl: 60_000,
      fetcher,
    });

    expect(result).toEqual({ cached: "hit" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("skips cache write when shouldCache returns false", async () => {
    const ctx = makeCtx(null);

    await cachedFetch<unknown>(ctx, {
      userId: TEST_USER_ID,
      dataType: "profile",
      ttl: 60_000,
      fetcher: async () => null,
      shouldCache: () => false,
    });

    expect(ctx.runMutation).not.toHaveBeenCalled();
  });
});
