import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FunctionReference, getFunctionName } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { refreshTonalToken } from "./auth";
import { backfillThumbnails } from "./movementSync";
import { doSyncWorkoutCatalog } from "./workoutCatalogSync";

vi.mock("./auth", () => ({ refreshTonalToken: vi.fn() }));
vi.mock("./encryption", () => ({
  decrypt: vi.fn(async (value: string) => value.replace(/^encrypted:/, "")),
  encrypt: vi.fn(async (value: string) => `encrypted:${value}`),
}));
vi.mock("../lib/posthog", () => ({
  captureSystem: vi.fn(),
  flush: vi.fn(),
}));

const USER_ID = "test-user" as Id<"users">;
const MOVEMENT_ID = "movement-1";
const TOKEN_PROFILE = {
  tonalToken: "encrypted:old-token",
  tonalRefreshToken: "encrypted:refresh-token",
  tonalUserId: "tonal-user",
};

type QueryFallback = (name: string, args: Record<string, unknown> | undefined) => unknown;
type MutationFallback = (name: string, args: Record<string, unknown>) => unknown;
type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;

function getHandler<T>(registered: unknown): T {
  return (registered as { _handler: T })._handler;
}

function makeCtx(options: {
  query?: QueryFallback;
  mutation?: MutationFallback;
  store?: (blob: Blob) => Promise<Id<"_storage">>;
}) {
  const runQuery = vi.fn(async (ref: TestFunctionReference, args?: Record<string, unknown>) => {
    const name = getFunctionName(ref);
    if (name === "tonal/cache:getUserProfile") return TOKEN_PROFILE;
    return options.query?.(name, args);
  });
  const runMutation = vi.fn(async (ref: TestFunctionReference, args: Record<string, unknown>) => {
    const name = getFunctionName(ref);
    if (name === "userProfiles:acquireTokenRefreshLock") return true;
    return options.mutation?.(name, args);
  });
  const store = vi.fn(options.store ?? (async () => "storage-id" as Id<"_storage">));
  const runAfter = vi.fn();
  const ctx = {
    runQuery,
    runMutation,
    storage: { store },
    scheduler: { runAfter },
  } as unknown as ActionCtx;
  return { ctx, runMutation, runAfter, store };
}

function argsForCalls(
  mock: ReturnType<typeof vi.fn>,
  functionName: string,
): Array<Record<string, unknown>> {
  return mock.mock.calls
    .filter(([ref]) => getFunctionName(ref as TestFunctionReference) === functionName)
    .map(([, args]) => args as Record<string, unknown>);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fetchCount(fetchMock: ReturnType<typeof vi.fn>, path: string, method = "GET"): number {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const options = init as RequestInit | undefined;
    return String(input).endsWith(path) && (options?.method ?? "GET") === method;
  }).length;
}

const backfillHandler =
  getHandler<(ctx: ActionCtx, args: { batchSize?: number }) => Promise<void>>(backfillThumbnails);
const catalogHandler =
  getHandler<(ctx: ActionCtx, args: { userId: Id<"users"> }) => Promise<void>>(
    doSyncWorkoutCatalog,
  );

describe("Tonal action auth retry boundaries", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    vi.mocked(refreshTonalToken).mockResolvedValue({
      idToken: "fresh-token",
      refreshToken: "fresh-refresh-token",
      expiresAt: 2_000_000_000_000,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("retries only the unauthorized thumbnail and logs a later non-auth failure", async () => {
    const docs = ["asset-1", "asset-2", "asset-3"].map((imageAssetId, index) => ({
      _id: `movement-${index}` as Id<"movements">,
      imageAssetId,
    }));
    const { ctx, store, runAfter } = makeCtx({
      query: (name) => {
        if (name === "userProfiles:getUserWithValidToken") return { userId: USER_ID };
        if (name === "tonal/movementSync:getMovementsMissingThumbnails") return docs;
        throw new Error("Unexpected query");
      },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (url.endsWith("/asset-2") && authorization === "Bearer old-token") {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.endsWith("/asset-3")) return new Response("Unavailable", { status: 503 });
      return new Response(new Blob(["image"]), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await backfillHandler(ctx, { batchSize: 4 });

    expect(fetchCount(fetchMock, "/v6/assets/asset-1")).toBe(1);
    expect(fetchCount(fetchMock, "/v6/assets/asset-2")).toBe(2);
    expect(fetchCount(fetchMock, "/v6/assets/asset-3")).toBe(1);
    expect(store).toHaveBeenCalledTimes(2);
    expect(runAfter).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith("[movementSync] Asset fetch asset-3 returned 503");
  });

  it("retries catalog details without replaying earlier writes and logs omitted 5xx", async () => {
    const { ctx, runMutation } = makeCtx({
      mutation: (name) =>
        name === "tonal/workoutCatalogSync:batchUpdateMovementTrainingTypes"
          ? { updated: 1, skipped: 0 }
          : undefined,
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (url.endsWith("/v6/training-types")) {
        return jsonResponse([{ id: "type-1", name: "Strength", description: "" }]);
      }
      if (url.endsWith("/v6/explore/workouts")) {
        return jsonResponse([
          {
            title: "Strength",
            total: 2,
            tiles: [
              { workoutId: "auth-workout", trainingTypeIds: ["type-1"] },
              { workoutId: "failed-workout", trainingTypeIds: ["type-1"] },
            ],
          },
        ]);
      }
      if (url.endsWith("/auth-workout") && authorization === "Bearer old-token") {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.endsWith("/failed-workout")) {
        return new Response("Unavailable", { status: 503 });
      }
      return jsonResponse({ id: "auth-workout", sets: [{ movementId: MOVEMENT_ID }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await catalogHandler(ctx, { userId: USER_ID });

    expect(fetchCount(fetchMock, "/v6/training-types")).toBe(1);
    expect(fetchCount(fetchMock, "/v6/explore/workouts")).toBe(1);
    expect(fetchCount(fetchMock, "/v6/workouts/auth-workout")).toBe(2);
    expect(fetchCount(fetchMock, "/v6/workouts/failed-workout")).toBe(2);
    expect(argsForCalls(runMutation, "tonal/workoutCatalogSync:upsertTrainingType")).toHaveLength(
      1,
    );
    expect(console.warn).toHaveBeenCalledWith(
      "[workoutCatalogSync] Failed to fetch workout failed-workout:",
      expect.objectContaining({ status: 503 }),
    );
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
