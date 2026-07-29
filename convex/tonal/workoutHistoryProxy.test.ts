import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { encrypt } from "./encryption";
import {
  fetchWorkoutHistory,
  fetchWorkoutHistoryForEligibility,
  fetchWorkoutHistoryPage,
} from "./workoutHistoryProxy";
import type { Activity } from "./types";

const TEST_USER_ID = "test-user" as Id<"users">;
const TEST_ENCRYPTION_KEY = "a".repeat(64);
const NOW = 1_800_000_000_000;

type EligibilityHandler = (ctx: ActionCtx, args: { userId: Id<"users"> }) => Promise<Activity[]>;
type RecentHistoryHandler = EligibilityHandler;
type PageHandler = (
  ctx: ActionCtx,
  args: { userId: Id<"users">; offset: number },
) => Promise<{ activities: Activity[]; pageSize: number; pgTotal: number }>;

interface CacheRow {
  data: unknown;
  fetchedAt: number;
  expiresAt: number;
}

const handler = (fetchWorkoutHistoryForEligibility as unknown as { _handler: EligibilityHandler })
  ._handler;
const recentHistoryHandler = (
  fetchWorkoutHistory as unknown as {
    _handler: RecentHistoryHandler;
  }
)._handler;
const pageHandler = (fetchWorkoutHistoryPage as unknown as { _handler: PageHandler })._handler;

function makeCtx(
  profile: { tonalToken: string; tonalUserId: string },
  cache: Map<string, CacheRow>,
) {
  return {
    runQuery: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
      if ("dataType" in args) return cache.get(String(args.dataType)) ?? null;
      return profile;
    }),
    runMutation: vi.fn(async (_ref: unknown, args: Record<string, unknown>) => {
      if (!("dataType" in args) || !("data" in args)) return undefined;
      cache.set(String(args.dataType), {
        data: args.data,
        fetchedAt: Number(args.fetchedAt),
        expiresAt: Number(args.expiresAt),
      });
      return undefined;
    }),
  } as unknown as ActionCtx;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.TOKEN_ENCRYPTION_KEY;
});

describe("fetchWorkoutHistoryForEligibility", () => {
  it("keeps eligibility results fresh for exactly five minutes", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const profile = {
      tonalToken: await encrypt("access-token", TEST_ENCRYPTION_KEY),
      tonalUserId: "tonal-user",
    };
    const cache = new Map<string, CacheRow>();
    const fetchMock = vi.fn(
      async () =>
        new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    await handler(makeCtx(profile, cache), { userId: TEST_USER_ID });

    const firstEntry = cache.get("workoutHistoryEligibility");
    expect(firstEntry).toBeDefined();
    if (!firstEntry) throw new Error("Expected eligibility cache entry");
    expect(firstEntry.expiresAt - firstEntry.fetchedAt).toBe(300_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 299_999);
    await handler(makeCtx(profile, cache), { userId: TEST_USER_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 300_000);
    await handler(makeCtx(profile, cache), { userId: TEST_USER_ID });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("workout history cache versioning", () => {
  it("ignores a fresh recent-history entry created by the old pagination logic", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const profile = {
      tonalToken: await encrypt("access-token", TEST_ENCRYPTION_KEY),
      tonalUserId: "tonal-user",
    };
    const cache = new Map<string, CacheRow>([
      [
        "workoutHistory_v3",
        { data: [{ activityId: "legacy-truncated" }], fetchedAt: NOW, expiresAt: NOW + 300_000 },
      ],
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json([], { headers: { "pg-total": "0" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const result = await recentHistoryHandler(makeCtx(profile, cache), { userId: TEST_USER_ID });

    expect(result).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.has("workoutHistory_v4")).toBe(true);
  });

  it("ignores a fresh backfill page created with relative pgTotal semantics", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const profile = {
      tonalToken: await encrypt("access-token", TEST_ENCRYPTION_KEY),
      tonalUserId: "tonal-user",
    };
    const cache = new Map<string, CacheRow>([
      [
        "workoutPage:200",
        {
          data: { activities: [{ activityId: "legacy-truncated" }], pageSize: 200, pgTotal: 201 },
          fetchedAt: NOW,
          expiresAt: NOW + 300_000,
        },
      ],
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json([], { headers: { "pg-total": "200" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const result = await pageHandler(makeCtx(profile, cache), {
      userId: TEST_USER_ID,
      offset: 200,
    });

    expect(result).toEqual({ activities: [], pageSize: 0, pgTotal: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.has("workoutPage_v2:200")).toBe(true);
  });
});
