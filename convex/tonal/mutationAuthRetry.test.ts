import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FunctionReference, getFunctionName } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { refreshTonalToken } from "./auth";
import { deleteAllCustomWorkouts, pushWorkoutToTonal } from "./mutations";
import { TonalSessionExpiredError } from "./tokenRetry";
import type { BlockInput } from "./transforms";

vi.mock("./auth", () => ({ refreshTonalToken: vi.fn() }));
vi.mock("./encryption", () => ({
  decrypt: vi.fn(async (value: string) => value.replace(/^encrypted:/, "")),
  encrypt: vi.fn(async (value: string) => `encrypted:${value}`),
}));

const USER_ID = "test-user" as Id<"users">;
const MOVEMENT_ID = "movement-1";
const TOKEN_PROFILE = {
  tonalToken: "encrypted:old-token",
  tonalRefreshToken: "encrypted:refresh-token",
  tonalUserId: "tonal-user",
};

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;

function getHandler<T>(registered: unknown): T {
  return (registered as { _handler: T })._handler;
}

function makeCtx(query?: (name: string) => unknown) {
  const runQuery = vi.fn(async (ref: TestFunctionReference) => {
    const name = getFunctionName(ref);
    if (name === "tonal/cache:getUserProfile") return TOKEN_PROFILE;
    return query?.(name);
  });
  const runMutation = vi.fn(async (ref: TestFunctionReference) => {
    if (getFunctionName(ref) === "userProfiles:acquireTokenRefreshLock") return true;
    return undefined;
  });
  const ctx = { runQuery, runMutation } as unknown as ActionCtx;
  return { ctx, runMutation };
}

function argsForCalls(
  mock: ReturnType<typeof vi.fn>,
  functionName: string,
): Array<Record<string, unknown>> {
  return mock.mock.calls
    .filter(([ref]) => getFunctionName(ref as TestFunctionReference) === functionName)
    .map(([, args]) => args as Record<string, unknown>);
}

function jsonResponse(data: unknown): Response {
  return Response.json(data);
}

function fetchCount(fetchMock: ReturnType<typeof vi.fn>, path: string, method = "GET"): number {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const options = init as RequestInit | undefined;
    return String(input).endsWith(path) && (options?.method ?? "GET") === method;
  }).length;
}

const deleteAllHandler =
  getHandler<(ctx: ActionCtx, args: { userId: Id<"users"> }) => Promise<{ deleted: number }>>(
    deleteAllCustomWorkouts,
  );
const pushHandler =
  getHandler<
    (
      ctx: ActionCtx,
      args: { userId: Id<"users">; title: string; blocks: BlockInput[] },
    ) => Promise<{ id: string; setCount: number; pushDivergence: unknown } | { error: string }>
  >(pushWorkoutToTonal);

describe("Tonal mutation action auth retry boundaries", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    vi.mocked(refreshTonalToken).mockResolvedValue({
      idToken: "fresh-token",
      refreshToken: "fresh-refresh-token",
      expiresAt: 2_000_000_000_000,
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("retries only the unauthorized delete, logs 5xx, and evicts the cache", async () => {
    vi.useFakeTimers();
    const { ctx, runMutation } = makeCtx();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (url.endsWith("/v6/user-workouts") && init?.method !== "DELETE") {
        return jsonResponse([{ id: "workout-1" }, { id: "workout-2" }, { id: "workout-3" }]);
      }
      if (url.endsWith("/workout-2") && authorization === "Bearer old-token") {
        return new Response("Unauthorized", { status: 401 });
      }
      if (url.endsWith("/workout-3")) return new Response("Unavailable", { status: 503 });
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = deleteAllHandler(ctx, { userId: USER_ID });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toEqual({ deleted: 2 });
    expect(fetchCount(fetchMock, "/v6/user-workouts")).toBe(1);
    expect(fetchCount(fetchMock, "/v6/user-workouts/workout-1", "DELETE")).toBe(1);
    expect(fetchCount(fetchMock, "/v6/user-workouts/workout-2", "DELETE")).toBe(2);
    expect(fetchCount(fetchMock, "/v6/user-workouts/workout-3", "DELETE")).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to delete workout workout-3:",
      expect.objectContaining({ status: 503 }),
    );
    expect(argsForCalls(runMutation, "tonal/cache:deleteCacheEntryByType")).toContainEqual({
      userId: USER_ID,
      dataType: "customWorkouts",
    });
  });

  it("evicts the cache when a partial bulk delete ends in terminal auth failure", async () => {
    vi.useFakeTimers();
    const { ctx, runMutation } = makeCtx();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v6/user-workouts") && init?.method !== "DELETE") {
        return jsonResponse([{ id: "workout-1" }, { id: "workout-2" }]);
      }
      if (url.endsWith("/workout-1")) return new Response(null, { status: 204 });
      return new Response("Unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const settled = deleteAllHandler(ctx, { userId: USER_ID }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(error).toBeInstanceOf(TonalSessionExpiredError);
    expect(fetchCount(fetchMock, "/v6/user-workouts/workout-1", "DELETE")).toBe(1);
    expect(fetchCount(fetchMock, "/v6/user-workouts/workout-2", "DELETE")).toBe(2);
    expect(argsForCalls(runMutation, "tonal/cache:deleteCacheEntryByType")).toContainEqual({
      userId: USER_ID,
      dataType: "customWorkouts",
    });
    expect(argsForCalls(runMutation, "userProfiles:markTokenExpired")).toContainEqual({
      userId: USER_ID,
    });
  });

  it("preserves terminal auth failure when cache eviction also fails", async () => {
    vi.useFakeTimers();
    const { ctx, runMutation } = makeCtx();
    runMutation.mockImplementation(async (ref: TestFunctionReference) => {
      const name = getFunctionName(ref);
      if (name === "userProfiles:acquireTokenRefreshLock") return true;
      if (name === "tonal/cache:deleteCacheEntryByType") {
        throw new Error("Cache unavailable");
      }
      return undefined;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v6/user-workouts") && init?.method !== "DELETE") {
        return jsonResponse([{ id: "workout-1" }, { id: "workout-2" }]);
      }
      if (url.endsWith("/workout-1")) return new Response(null, { status: 204 });
      return new Response("Unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const settled = deleteAllHandler(ctx, { userId: USER_ID }).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await settled;

    expect(error).toBeInstanceOf(TonalSessionExpiredError);
    expect(console.error).toHaveBeenCalledWith(
      "Custom workout cache eviction failed",
      expect.objectContaining({ message: "Cache unavailable" }),
    );
  });

  it("refreshes a 401 read-back without issuing a second workout POST", async () => {
    const { ctx } = makeCtx((name) => {
      if (name === "tonal/movementSync:getAllMovements") {
        return [{ id: MOVEMENT_ID, countReps: true, isAlternating: false }];
      }
      throw new Error(`Unexpected query ${name}`);
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (url.endsWith("/v6/user-workouts") && init?.method === "POST") {
        return jsonResponse({ id: "created-workout" });
      }
      if (authorization === "Bearer old-token") {
        return new Response("Unauthorized", { status: 401 });
      }
      return jsonResponse({ id: "created-workout", sets: [{ movementId: MOVEMENT_ID }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pushHandler(ctx, {
      userId: USER_ID,
      title: "Push Day",
      blocks: [{ exercises: [{ movementId: MOVEMENT_ID, sets: 1, reps: 8 }] }],
    });

    expect(result).toMatchObject({ id: "created-workout", setCount: 1, pushDivergence: null });
    expect(fetchCount(fetchMock, "/v6/user-workouts", "POST")).toBe(1);
    expect(fetchCount(fetchMock, "/v6/user-workouts/created-workout")).toBe(2);
  });

  it("returns the created workout when read-back remains unauthorized after refresh", async () => {
    const { ctx, runMutation } = makeCtx((name) => {
      if (name === "tonal/movementSync:getAllMovements") {
        return [{ id: MOVEMENT_ID, countReps: true, isAlternating: false }];
      }
      throw new Error(`Unexpected query ${name}`);
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v6/user-workouts") && init?.method === "POST") {
        return jsonResponse({ id: "created-workout" });
      }
      return new Response("Unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pushHandler(ctx, {
      userId: USER_ID,
      title: "Push Day",
      blocks: [{ exercises: [{ movementId: MOVEMENT_ID, sets: 1, reps: 8 }] }],
    });

    expect(result).toMatchObject({ id: "created-workout", setCount: 1, pushDivergence: null });
    expect(fetchCount(fetchMock, "/v6/user-workouts", "POST")).toBe(1);
    expect(fetchCount(fetchMock, "/v6/user-workouts/created-workout")).toBe(2);
    expect(argsForCalls(runMutation, "userProfiles:markTokenExpired")).toContainEqual({
      userId: USER_ID,
    });
    expect(console.warn).toHaveBeenCalledWith(
      "Push verification: failed for created-workout",
      expect.any(TonalSessionExpiredError),
    );
  });

  it("returns the created workout when read-back token refresh fails unexpectedly", async () => {
    const { ctx, runMutation } = makeCtx((name) => {
      if (name === "tonal/movementSync:getAllMovements") {
        return [{ id: MOVEMENT_ID, countReps: true, isAlternating: false }];
      }
      throw new Error(`Unexpected query ${name}`);
    });
    runMutation.mockImplementation(async (ref: TestFunctionReference) => {
      if (getFunctionName(ref) === "userProfiles:acquireTokenRefreshLock") {
        throw new Error("Refresh lock unavailable");
      }
      return undefined;
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/v6/user-workouts") && init?.method === "POST") {
        return jsonResponse({ id: "created-workout" });
      }
      return new Response("Unauthorized", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pushHandler(ctx, {
      userId: USER_ID,
      title: "Push Day",
      blocks: [{ exercises: [{ movementId: MOVEMENT_ID, sets: 1, reps: 8 }] }],
    });

    expect(result).toMatchObject({ id: "created-workout", setCount: 1, pushDivergence: null });
    expect(fetchCount(fetchMock, "/v6/user-workouts", "POST")).toBe(1);
    expect(fetchCount(fetchMock, "/v6/user-workouts/created-workout")).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(
      "Push verification: failed for created-workout",
      expect.objectContaining({ message: "Refresh lock unavailable" }),
    );
  });
});
