/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import schema from "./schema";
import { type DeleteWeekPlanResult, deleteWeekPlanWithTonal } from "./weekPlanDeletion";
import { deleteWorkoutFromTonal } from "./tonal/mutations";

vi.mock("./tonal/encryption", () => ({
  decrypt: vi.fn(async (value: string) => value.replace(/^encrypted:/, "")),
  encrypt: vi.fn(async (value: string) => `encrypted:${value}`),
}));

const modules = import.meta.glob("./**/*.*s");

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;

function getHandler<T>(registered: unknown): T {
  return (registered as { _handler: T })._handler;
}

const deletionHandler =
  getHandler<
    (
      ctx: ActionCtx,
      args: { userId: Id<"users">; weekPlanId: Id<"weekPlans"> },
    ) => Promise<DeleteWeekPlanResult>
  >(deleteWeekPlanWithTonal);
const remoteDeleteHandler =
  getHandler<
    (
      ctx: ActionCtx,
      args: { userId: Id<"users">; workoutId: string },
    ) => Promise<{ status: "deleted" | "absent" }>
  >(deleteWorkoutFromTonal);

async function seedTwoWorkoutWeek(options?: { completed?: boolean }) {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const firstWorkoutPlanId = await ctx.db.insert("workoutPlans", {
      userId,
      tonalWorkoutId: "tonal-1",
      title: "Monday",
      blocks: [],
      status: "pushed",
      createdAt: 1,
    });
    const secondWorkoutPlanId = await ctx.db.insert("workoutPlans", {
      userId,
      tonalWorkoutId: "tonal-2",
      title: "Tuesday",
      blocks: [],
      status: "pushed",
      createdAt: 2,
    });
    const weekPlanId = await ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: "2026-08-03",
      preferredSplit: "upper_lower",
      targetDays: 2,
      days: [
        {
          sessionType: "upper",
          status: options?.completed ? "completed" : "programmed",
          workoutPlanId: firstWorkoutPlanId,
        },
        { sessionType: "lower", status: "programmed", workoutPlanId: secondWorkoutPlanId },
        ...Array.from({ length: 5 }, () => ({
          sessionType: "rest" as const,
          status: "programmed" as const,
        })),
      ],
      createdAt: 1,
      updatedAt: 1,
    });
    return { userId, weekPlanId, firstWorkoutPlanId, secondWorkoutPlanId };
  });
  return { t, ...seeded };
}

function makeActionCtx(t: ReturnType<typeof convexTest>): ActionCtx {
  const runQuery = vi.fn(async (ref: TestFunctionReference) => {
    if (getFunctionName(ref) === "tonal/cache:getUserProfile") {
      return {
        tonalToken: "encrypted:access-token",
        tonalRefreshToken: "encrypted:refresh-token",
        tonalUserId: "tonal-user",
      };
    }
    throw new Error(`Unexpected query ${getFunctionName(ref)}`);
  });
  const runMutation = vi.fn(
    async (ref: TestFunctionReference, args: Record<string, unknown>): Promise<unknown> => {
      let name: string;
      try {
        name = getFunctionName(ref);
      } catch {
        return { ok: true };
      }
      if (name.startsWith("weekPlanDeletionState:")) {
        const invoke = t.mutation as unknown as (
          target: TestFunctionReference,
          targetArgs: Record<string, unknown>,
        ) => Promise<unknown>;
        return invoke(ref, args);
      }
      if (name === "tonal/cache:deleteCacheEntryByType") return null;
      if (name.includes("rateLimit")) return { ok: true };
      throw new Error(`Unexpected mutation ${name}`);
    },
  );
  const runAction = vi.fn(async (ref: TestFunctionReference, args: Record<string, unknown>) => {
    if (getFunctionName(ref) === "tonal/mutations:deleteWorkoutFromTonal") {
      return remoteDeleteHandler(ctx, args as { userId: Id<"users">; workoutId: string });
    }
    throw new Error(`Unexpected action ${getFunctionName(ref)}`);
  });
  const ctx = { runQuery, runMutation, runAction } as unknown as ActionCtx;
  return ctx;
}

describe("week-plan deletion action receipts", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "a".repeat(64);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TOKEN_ENCRYPTION_KEY;
  });

  it("checkpoints a partial remote failure and retry skips the confirmed target", async () => {
    const seeded = await seedTwoWorkoutWeek();
    const ctx = makeActionCtx(seeded.t);
    const firstFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("Unavailable", { status: 503 }));
    vi.stubGlobal("fetch", firstFetch);

    const partial = await deletionHandler(ctx, {
      userId: seeded.userId,
      weekPlanId: seeded.weekPlanId,
    });

    expect(partial).toMatchObject({
      deleted: false,
      status: "needs_attention",
      retryable: true,
      removedFromTonal: 1,
    });
    const afterPartial = await seeded.t.run((db) => db.db.get(seeded.weekPlanId));
    expect(afterPartial?.deletionReservation).toMatchObject({
      state: "needs_attention",
      reason: "remote_failure",
      targets: [
        { tonalWorkoutId: "tonal-1", remoteStatus: "absent" },
        { tonalWorkoutId: "tonal-2", remoteStatus: "pending" },
      ],
    });
    expect(firstFetch).toHaveBeenCalledTimes(2);

    const retryFetch = vi.fn().mockResolvedValue(new Response("Not found", { status: 404 }));
    vi.stubGlobal("fetch", retryFetch);
    const retried = await deletionHandler(ctx, {
      userId: seeded.userId,
      weekPlanId: seeded.weekPlanId,
    });

    expect(retried).toEqual({ deleted: true, removedFromTonal: 2 });
    expect(retryFetch).toHaveBeenCalledOnce();
    expect(String(retryFetch.mock.calls[0]?.[0])).toContain("/tonal-2");
    await expect(seeded.t.run((db) => db.db.get(seeded.weekPlanId))).resolves.toBeNull();
    await expect(seeded.t.run((db) => db.db.get(seeded.firstWorkoutPlanId))).resolves.toBeNull();
    await expect(seeded.t.run((db) => db.db.get(seeded.secondWorkoutPlanId))).resolves.toBeNull();
  });

  it("never reaches Tonal when reservation preflight sees completed history", async () => {
    const seeded = await seedTwoWorkoutWeek({ completed: true });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await deletionHandler(makeActionCtx(seeded.t), {
      userId: seeded.userId,
      weekPlanId: seeded.weekPlanId,
    });

    expect(result).toMatchObject({ deleted: false, status: "blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(seeded.t.run((db) => db.db.get(seeded.weekPlanId))).resolves.not.toBeNull();
  });
});
