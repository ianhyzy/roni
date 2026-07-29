import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FunctionReference, getFunctionName } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { TonalApiError } from "./client";
import { deleteWorkout, estimateWorkout, pushWorkoutToTonal, shareWorkout } from "./mutations";
import type { WorkoutEstimate } from "./types";
import type { BlockInput } from "./transforms";

vi.mock("./encryption", () => ({
  decrypt: vi.fn(async (value: string) => value.replace(/^encrypted:/, "")),
  encrypt: vi.fn(async (value: string) => `encrypted:${value}`),
}));

const USER_ID = "test-user" as Id<"users">;
const MOVEMENT_ID = "movement-1";
const TOKEN_PROFILE = {
  tonalToken: "encrypted:access-token",
  tonalRefreshToken: "encrypted:refresh-token",
  tonalUserId: "tonal-user",
};
const BLOCKS: BlockInput[] = [{ exercises: [{ movementId: MOVEMENT_ID, sets: 1, reps: 8 }] }];
const CATALOG = [{ id: MOVEMENT_ID, countReps: true, isAlternating: false }];

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;

function getHandler<T>(registered: unknown): T {
  return (registered as { _handler: T })._handler;
}

function makeCtx(catalog = CATALOG) {
  const runQuery = vi.fn(async (ref: TestFunctionReference) => {
    const name = getFunctionName(ref);
    if (name === "tonal/cache:getUserProfile") return TOKEN_PROFILE;
    if (name === "tonal/movementSync:getAllMovements") return catalog;
    throw new Error(`Unexpected query ${name}`);
  });
  const runMutation = vi.fn(
    async (_ref: TestFunctionReference, _args?: Record<string, unknown>) => undefined,
  );
  const ctx = { runQuery, runMutation } as unknown as ActionCtx;
  return { ctx, runMutation };
}

function mutationCalls(mock: ReturnType<typeof vi.fn>) {
  return mock.mock.calls.map(([ref, args]) => ({
    name: getFunctionName(ref as TestFunctionReference),
    args: args as Record<string, unknown>,
  }));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const pushHandler =
  getHandler<
    (
      ctx: ActionCtx,
      args: { userId: Id<"users">; title: string; blocks: BlockInput[] },
    ) => Promise<{ id: string; setCount: number; pushDivergence: unknown } | { error: string }>
  >(pushWorkoutToTonal);
const shareHandler =
  getHandler<
    (
      ctx: ActionCtx,
      args: { userId: Id<"users">; workoutId: string },
    ) => Promise<{ deepLinkUrl: string }>
  >(shareWorkout);
const deleteHandler =
  getHandler<
    (ctx: ActionCtx, args: { userId: Id<"users">; workoutId: string }) => Promise<{ deleted: true }>
  >(deleteWorkout);
const estimateHandler =
  getHandler<
    (
      ctx: ActionCtx,
      args: { userId: Id<"users">; blocks: BlockInput[] },
    ) => Promise<WorkoutEstimate>
  >(estimateWorkout);

describe("Tonal mutation action wire contracts", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("posts a workout to the exact user-workouts path", async () => {
    const { ctx } = makeCtx();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.tonal.com/v6/user-workouts" && init?.method === "POST") {
        return jsonResponse({ id: "created-workout" });
      }
      if (url === "https://api.tonal.com/v6/user-workouts/created-workout") {
        return jsonResponse({ id: "created-workout", sets: [{ movementId: MOVEMENT_ID }] });
      }
      throw new Error(`Unexpected request ${init?.method ?? "GET"} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pushHandler(ctx, {
      userId: USER_ID,
      title: "Push Day",
      blocks: BLOCKS,
    });

    expect(result).toMatchObject({ id: "created-workout", setCount: 1 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.tonal.com/v6/user-workouts");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      title: "Push Day",
      createdSource: "WorkoutBuilder",
      sets: [{ movementId: MOVEMENT_ID, prescribedReps: 8 }],
    });
  });

  it("rejects a workout when the movement catalog is empty without calling Tonal", async () => {
    const { ctx } = makeCtx([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      pushHandler(ctx, { userId: USER_ID, title: "Push Day", blocks: BLOCKS }),
    ).rejects.toThrow("Movement catalog is empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a share request to the user-scoped workout path", async () => {
    const { ctx } = makeCtx();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ deepLinkUrl: "tonal://workout" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await shareHandler(ctx, { userId: USER_ID, workoutId: "workout-1" });

    expect(result).toEqual({ deepLinkUrl: "tonal://workout" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tonal.com/v6/users/tonal-user/user-workouts/workout-1/share",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("propagates a failed share response as a Tonal API error", async () => {
    const { ctx } = makeCtx();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })));

    const error = await shareHandler(ctx, { userId: USER_ID, workoutId: "workout-1" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(TonalApiError);
    expect(error).toMatchObject({ status: 503, body: "Unavailable" });
  });

  it("accepts a 204 delete and removes the real custom-workouts cache entry", async () => {
    const { ctx, runMutation } = makeCtx();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteHandler(ctx, { userId: USER_ID, workoutId: "workout-1" });

    expect(result).toEqual({ deleted: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tonal.com/v6/user-workouts/workout-1",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(mutationCalls(runMutation)).toEqual([
      {
        name: "workoutPlans:markDeleted",
        args: { tonalWorkoutId: "workout-1" },
      },
      {
        name: "tonal/cache:deleteCacheEntryByType",
        args: { userId: USER_ID, dataType: "customWorkouts" },
      },
    ]);
  });

  it("does not update Convex state when Tonal rejects a delete", async () => {
    const { ctx, runMutation } = makeCtx();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 })));

    await expect(
      deleteHandler(ctx, { userId: USER_ID, workoutId: "workout-1" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("keeps a successful Tonal delete successful when cache eviction fails", async () => {
    const { ctx, runMutation } = makeCtx();
    runMutation.mockImplementation(async (ref: TestFunctionReference) => {
      if (getFunctionName(ref) === "tonal/cache:deleteCacheEntryByType") {
        throw new Error("Cache unavailable");
      }
      return undefined;
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await deleteHandler(ctx, { userId: USER_ID, workoutId: "workout-1" });

    expect(result).toEqual({ deleted: true });
    expect(console.error).toHaveBeenCalledWith(
      "Custom workout cache eviction failed",
      expect.objectContaining({ message: "Cache unavailable" }),
    );
  });

  it("posts a bare set array to the exact estimate path", async () => {
    const { ctx } = makeCtx();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ duration: 600 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await estimateHandler(ctx, { userId: USER_ID, blocks: BLOCKS });

    expect(result).toEqual({ duration: 600 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tonal.com/v6/user-workouts/estimate",
      expect.objectContaining({ method: "POST" }),
    );
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as unknown;
    expect(Array.isArray(requestBody)).toBe(true);
    expect(requestBody).toEqual([expect.objectContaining({ movementId: MOVEMENT_ID })]);
  });

  it("rejects an empty estimate without sending an invalid payload", async () => {
    const { ctx } = makeCtx();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(estimateHandler(ctx, { userId: USER_ID, blocks: [] })).rejects.toThrow(
      "estimateWorkout: no sets to estimate",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
