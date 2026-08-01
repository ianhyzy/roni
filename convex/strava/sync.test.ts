import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { rateLimiter } from "../rateLimits";
import { refreshStravaData, runInitialSync } from "./sync";

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return {
    ...actual,
    decryptStravaSecret: vi.fn(async () => "access-token"),
    getStravaAppConfig: () => ({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://app.test/strava/callback",
    }),
  };
});

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;
type SyncHandler = (
  ctx: ActionCtx,
  args: { userId: Id<"users">; athleteId: string; generation: string; attempt?: number },
) => Promise<{ success: boolean; activities?: number; error?: string; retryable?: boolean }>;
type RefreshHandler = (
  ctx: ActionCtx,
  args: Record<string, never>,
) => Promise<{ success: boolean; activities?: number; error?: string; retryable?: boolean }>;
type ContextFailures = {
  markProviderDisconnected?: boolean;
  recordSyncResult?: boolean;
  upsertActivityBatch?: boolean;
};

const syncHandler = (runInitialSync as unknown as { _handler: SyncHandler })._handler;
const refreshHandler = (refreshStravaData as unknown as { _handler: RefreshHandler })._handler;
const NOW = Date.parse("2026-07-30T12:00:00.000Z");
const userId = "user-1" as Id<"users">;

function functionName(ref: TestFunctionReference): string {
  return getFunctionName(ref);
}

function activity(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    athlete: { id: 42 },
    name: `Activity ${id}`,
    type: "Run",
    sport_type: "TrailRun",
    start_date: "2026-07-29T12:00:00.000Z",
    start_date_local: "2026-07-29T06:00:00.000Z",
    timezone: "(GMT-07:00) America/Denver",
    distance: 5_000,
    moving_time: 1_500,
    elapsed_time: 1_800,
    total_elevation_gain: 100,
    achievement_count: 1,
    trainer: false,
    commute: false,
    manual: false,
    private: false,
    ...overrides,
  };
}

function responseHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    "X-RateLimit-Limit": "200,2000",
    "X-RateLimit-Usage": "2,20",
    "X-ReadRateLimit-Limit": "100,1000",
    "X-ReadRateLimit-Usage": "2,20",
    ...extra,
  });
}

function createContext(failures: ContextFailures = {}) {
  const runQuery = vi.fn(async (ref: TestFunctionReference): Promise<unknown> => {
    if (functionName(ref) !== "strava/connections:getActiveConnectionByUserId") {
      throw new Error(`Unexpected query: ${functionName(ref)}`);
    }
    return {
      userId,
      athleteId: "42",
      generation: "generation-1",
      accessTokenEncrypted: "encrypted-access",
      refreshTokenEncrypted: "encrypted-refresh",
      tokenExpiresAt: NOW + 60 * 60 * 1_000,
      scopes: ["activity:read"],
      connectedAt: NOW - 1_000,
    };
  });
  const runMutation = vi.fn(async (ref: TestFunctionReference, args: Record<string, unknown>) => {
    switch (functionName(ref)) {
      case "strava/rateLimitBudget:reserveRequest":
        return { allowed: true };
      case "strava/rateLimitBudget:recordResponseHeaders":
      case "strava/rateLimitBudget:markResponseUnknown":
      case "strava/rateLimitBudget:markTransportFailure":
        return null;
      case "strava/connections:acquireRefreshLease":
        return { state: "acquired", refreshTokenEncrypted: "encrypted-refresh" };
      case "strava/connections:releaseRefreshLease":
        return true;
      case "strava/activityPersistence:upsertActivityBatch": {
        if (failures.upsertActivityBatch) throw new Error("database unavailable");
        return (args.activities as unknown[]).length;
      }
      case "strava/syncState:recordSyncResult": {
        if (failures.recordSyncResult) throw new Error("bookkeeping unavailable");
        return true;
      }
      case "strava/syncState:markProviderDisconnected": {
        if (failures.markProviderDisconnected) throw new Error("finalization unavailable");
        return true;
      }
      default:
        throw new Error(`Unexpected mutation: ${functionName(ref)}`);
    }
  });
  const runAfter = vi.fn(async () => "scheduled-sync");
  return {
    ctx: { runQuery, runMutation, scheduler: { runAfter } } as unknown as ActionCtx,
    runQuery,
    runMutation,
    runAfter,
  };
}

function mutationCalls(runMutation: ReturnType<typeof createContext>["runMutation"], name: string) {
  return runMutation.mock.calls.filter(
    ([ref]) => functionName(ref as TestFunctionReference) === name,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Strava initial sync", () => {
  it("imports only the prior 30 days and stops after two pages of 100", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const firstPage = Array.from({ length: 100 }, (_, index) => activity(index + 1));
    const secondPage = [activity(101)];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(firstPage), { headers: responseHeaders() }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(secondPage), { headers: responseHeaders() }),
      );
    const { ctx, runMutation } = createContext();

    await expect(
      syncHandler(ctx, { userId, athleteId: "42", generation: "generation-1" }),
    ).resolves.toEqual({ success: true, activities: 101 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls.map((url) => url.origin)).toEqual([
      "https://api-v3.strava.com",
      "https://api-v3.strava.com",
    ]);
    expect(urls.map((url) => url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(urls[0]?.searchParams.get("per_page")).toBe("100");
    expect(urls[0]?.searchParams.get("before")).toBe(String(Math.floor(NOW / 1_000)));
    expect(urls[0]?.searchParams.get("after")).toBe(
      String(Math.floor((NOW - 30 * 24 * 60 * 60 * 1_000) / 1_000)),
    );
    const upserts = runMutation.mock.calls.filter(
      ([ref]) =>
        functionName(ref as TestFunctionReference) ===
        "strava/activityPersistence:upsertActivityBatch",
    );
    expect(upserts).toHaveLength(2);
    expect((upserts[0]?.[1] as { activities: unknown[] }).activities).toHaveLength(100);
    expect((upserts[1]?.[1] as { activities: unknown[] }).activities).toHaveLength(1);
    const syncRecords = mutationCalls(runMutation, "strava/syncState:recordSyncResult");
    expect(syncRecords[0]?.[1]).toMatchObject({ result: "success", succeededAt: NOW });
  });

  it("rejects a malformed page before persistence and records a safe error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: 1 }]), { headers: responseHeaders() }),
    );
    const { ctx, runMutation, runAfter } = createContext();

    await expect(
      syncHandler(ctx, { userId, athleteId: "42", generation: "generation-1" }),
    ).resolves.toEqual({
      success: false,
      retryable: false,
      error: "Strava returned an invalid activity response.",
    });
    const names = runMutation.mock.calls.map(([ref]) => functionName(ref as TestFunctionReference));
    expect(names).not.toContain("strava/activityPersistence:upsertActivityBatch");
    expect(names).toContain("strava/syncState:recordSyncResult");
    expect(runAfter).not.toHaveBeenCalled();
  });

  it("returns a retryable provider rate-limit failure without persisting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: responseHeaders({ "Retry-After": "45" }),
      }),
    );
    const { ctx, runMutation, runAfter } = createContext();

    await expect(
      syncHandler(ctx, { userId, athleteId: "42", generation: "generation-1" }),
    ).resolves.toEqual({
      success: false,
      retryable: true,
      error: "Strava rate limit reached.",
      retryAfterMs: 45_000,
    });
    expect(runAfter).toHaveBeenCalledWith(
      45_000,
      expect.anything(),
      expect.objectContaining({ generation: "generation-1", attempt: 2 }),
    );
    expect(
      runMutation.mock.calls.some(
        ([ref]) =>
          functionName(ref as TestFunctionReference) ===
          "strava/activityPersistence:upsertActivityBatch",
      ),
    ).toBe(false);
  });

  it.each([
    ["records the preserved authorization error", false],
    ["resolves when disconnect marking and failure recording both fail", true],
  ])("%s", async (_label, recordSyncResult) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401, headers: responseHeaders() }),
    );
    const current = createContext({ markProviderDisconnected: true, recordSyncResult });

    await expect(
      syncHandler(current.ctx, { userId, athleteId: "42", generation: "generation-1" }),
    ).resolves.toEqual({
      success: false,
      retryable: true,
      error: "Strava authorization is no longer valid.",
      retryAfterMs: undefined,
    });
    expect(current.runAfter).toHaveBeenCalledWith(
      30_000,
      expect.anything(),
      expect.objectContaining({ attempt: 2 }),
    );
    expect(mutationCalls(current.runMutation, "strava/syncState:recordSyncResult")).toHaveLength(1);
  });

  it.each([
    ["records activity persistence failures", false],
    ["resolves when persistence and failure recording both fail", true],
  ])("%s", async (_label, recordSyncResult) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([activity(1)]), { headers: responseHeaders() }),
    );
    const current = createContext({ upsertActivityBatch: true, recordSyncResult });

    await expect(
      syncHandler(current.ctx, { userId, athleteId: "42", generation: "generation-1" }),
    ).resolves.toEqual({
      success: false,
      retryable: true,
      error: "Strava activity persistence failed.",
    });
    const records = mutationCalls(current.runMutation, "strava/syncState:recordSyncResult");
    expect(records).toHaveLength(1);
    expect(records[0]?.[1]).toMatchObject({
      result: "failure",
      error: "Strava activity persistence failed.",
    });
    expect(current.runAfter).toHaveBeenCalledWith(
      30_000,
      expect.anything(),
      expect.objectContaining({ attempt: 2 }),
    );
  });

  it("returns a retryable bookkeeping failure without recursive recording", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([activity(1)]), { headers: responseHeaders() }),
    );
    const current = createContext({ recordSyncResult: true });

    await expect(
      syncHandler(current.ctx, { userId, athleteId: "42", generation: "generation-1" }),
    ).resolves.toEqual({
      success: false,
      retryable: true,
      error: "Strava sync bookkeeping failed.",
    });
    expect(mutationCalls(current.runMutation, "strava/syncState:recordSyncResult")).toHaveLength(1);
    expect(current.runAfter).toHaveBeenCalledWith(
      30_000,
      expect.anything(),
      expect.objectContaining({ attempt: 2 }),
    );
  });

  it("retries transport failures with bounded attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network unavailable"));
    const first = createContext();

    await expect(
      syncHandler(first.ctx, {
        userId,
        athleteId: "42",
        generation: "generation-1",
        attempt: 1,
      }),
    ).resolves.toEqual({
      success: false,
      retryable: true,
      error: "Strava request failed.",
      retryAfterMs: undefined,
    });
    expect(first.runAfter).toHaveBeenCalledWith(
      30_000,
      expect.anything(),
      expect.objectContaining({ attempt: 2 }),
    );

    const last = createContext();
    await syncHandler(last.ctx, {
      userId,
      athleteId: "42",
      generation: "generation-1",
      attempt: 3,
    });
    expect(last.runAfter).not.toHaveBeenCalled();
  });

  it("does not schedule retries from a manual refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(rateLimiter, "limit").mockResolvedValue({ ok: true, retryAfter: undefined });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 503,
        headers: responseHeaders(),
      }),
    );
    const manual = createContext();
    manual.runQuery.mockImplementation(async (ref: TestFunctionReference) => {
      switch (functionName(ref)) {
        case "lib/auth:resolveEffectiveUserId":
          return userId;
        case "strava/connections:getActiveConnectionByUserId":
          return {
            userId,
            athleteId: "42",
            generation: "generation-1",
            accessTokenEncrypted: "encrypted-access",
            refreshTokenEncrypted: "encrypted-refresh",
            tokenExpiresAt: NOW + 60 * 60 * 1_000,
            scopes: ["activity:read"],
            connectedAt: NOW - 1_000,
          };
        default:
          throw new Error(`Unexpected query: ${functionName(ref)}`);
      }
    });

    await expect(refreshHandler(manual.ctx, {})).resolves.toEqual({
      success: false,
      retryable: true,
      error: "Strava is temporarily unavailable.",
    });
    expect(manual.runAfter).not.toHaveBeenCalled();
  });
});
