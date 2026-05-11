import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { TonalApiError } from "./client";
import { encrypt } from "./encryption";
import { fetchWorkoutDetail } from "./proxy";
import type { WorkoutActivityDetail } from "./types";

const TEST_USER_ID = "test-user-123" as Id<"users">;
const TEST_TONAL_USER_ID = "tonal-456";
const TEST_ACTIVITY_ID = "activity-456";
const TEST_ENCRYPTION_KEY = "a".repeat(64);

type FetchWorkoutDetailHandler = (
  ctx: ActionCtx,
  args: { userId: Id<"users">; activityId: string },
) => Promise<WorkoutActivityDetail | null>;

const handler = (fetchWorkoutDetail as unknown as { _handler: FetchWorkoutDetailHandler })._handler;

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
      if (args.dataType) return null;
      return profile;
    }),
    runMutation: vi.fn(),
  } as unknown as ActionCtx;
}

async function runFetchWorkoutDetail(ctx: ActionCtx): Promise<WorkoutActivityDetail | null> {
  return handler(ctx, {
    userId: TEST_USER_ID,
    activityId: TEST_ACTIVITY_ID,
  });
}

describe("fetchWorkoutDetail outer error handler", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("returns null for tunnel/network errors", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("tunnel error: unsuccessful"));
    vi.stubGlobal("fetch", fetchMock);
    const ctx = await makeCtx();

    const result = await runFetchWorkoutDetail(ctx);

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.tonal.com/v6/users/${TEST_TONAL_USER_ID}/workout-activities/${TEST_ACTIVITY_ID}`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
  });

  it("returns null for non-auth TonalApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 })),
    );
    const ctx = await makeCtx();

    const result = await runFetchWorkoutDetail(ctx);

    expect(result).toBeNull();
  });

  it("returns null for generic non-auth errors", async () => {
    const ctx = await makeCtx();
    vi.mocked(ctx.runQuery).mockRejectedValueOnce(new Error("cache read failed"));

    const result = await runFetchWorkoutDetail(ctx);

    expect(result).toBeNull();
  });

  it("rethrows session-expired errors so the caller can prompt reconnect", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("Unauthorized", { status: 401 })),
    );
    const ctx = await makeCtx();

    await expect(runFetchWorkoutDetail(ctx)).rejects.toThrow("session expired");
    expect(ctx.runMutation).toHaveBeenCalled();
  });

  it("rethrows raw Tonal 401 errors", async () => {
    const ctx = {
      runQuery: vi.fn().mockRejectedValueOnce(new TonalApiError(401, "Unauthorized")),
      runMutation: vi.fn(),
    } as unknown as ActionCtx;

    await expect(runFetchWorkoutDetail(ctx)).rejects.toThrow(TonalApiError);
  });
});
