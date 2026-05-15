import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { encrypt } from "./encryption";
import { fetchWorkoutHistory } from "./workoutHistoryProxy";
import type { Activity } from "./types";

const TEST_USER_ID = "test-user-123" as Id<"users">;
const TEST_TONAL_USER_ID = "tonal-456";
const TEST_ENCRYPTION_KEY = "a".repeat(64);

type FetchWorkoutHistoryHandler = (
  ctx: ActionCtx,
  args: { userId: Id<"users">; limit?: number },
) => Promise<Activity[]>;

const handler = (fetchWorkoutHistory as unknown as { _handler: FetchWorkoutHistoryHandler })
  ._handler;

async function makeCtx(options: { includeRefreshToken?: boolean } = {}): Promise<ActionCtx> {
  const profile = {
    tonalToken: await encrypt("access-token", TEST_ENCRYPTION_KEY),
    tonalRefreshToken: options.includeRefreshToken
      ? await encrypt("refresh-token", TEST_ENCRYPTION_KEY)
      : undefined,
    tonalUserId: TEST_TONAL_USER_ID,
  };

  return {
    runQuery: vi.fn(async (_ref, args: { dataType?: string }) => {
      if (args?.dataType) return null; // cache miss
      return profile;
    }),
    runMutation: vi.fn(),
    runAction: vi.fn(),
  } as unknown as ActionCtx;
}

describe("fetchWorkoutHistory session-expired handling (TONALCOACH-3Z)", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("returns [] when the Tonal session is expired", async () => {
    // Regression for TONALCOACH-3Z: fetchWorkoutHistory was propagating the
    // 'session expired' error as an uncaught action failure to Sentry, even
    // though callers (fetchWorkoutHistoryOrNull, fetchWorkoutHistoryOrEmpty)
    // handled it correctly. The token is already marked expired in userProfiles
    // so the frontend reconnect modal fires from the DB field. The action should
    // return [] instead of throwing.
    const ctx = await makeCtx();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 })),
    );

    // 401 triggers markExpiredAndThrow when there's no refresh token.
    const result = await handler(ctx, { userId: TEST_USER_ID });

    expect(result).toEqual([]);
    // markTokenExpired was called so the DB state reflects the expiry
    expect(ctx.runMutation).toHaveBeenCalled();
  });

  it("still propagates unexpected non-auth errors", async () => {
    const ctx = await makeCtx();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unexpected infra error")));

    await expect(handler(ctx, { userId: TEST_USER_ID })).rejects.toThrow("unexpected infra error");
  });
});
