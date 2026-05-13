/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import { fetchWorkoutHistory, fetchWorkoutHistoryPage } from "./workoutHistoryProxy";

// Access the raw handler for unit testing without a full Convex runtime.
type FetchHistoryHandler = (
  ctx: ActionCtx,
  args: { userId: string; limit?: number },
) => Promise<unknown[]>;
type FetchPageHandler = (
  ctx: ActionCtx,
  args: { userId: string; offset: number },
) => Promise<{ activities: unknown[]; pageSize: number; pgTotal: number }>;

const fetchHistoryHandler = (fetchWorkoutHistory as unknown as { _handler: FetchHistoryHandler })
  ._handler;

const fetchPageHandler = (fetchWorkoutHistoryPage as unknown as { _handler: FetchPageHandler })
  ._handler;

describe("fetchWorkoutHistory session-expiry resilience (TONALCOACH-3Z)", () => {
  it("returns empty array instead of throwing when session is expired", async () => {
    // withTokenRetry calls markExpiredAndThrow which persists the expired state
    // to the DB before throwing. Catching here prevents Convex from reporting
    // this expected user-level condition to Sentry on every cron/AI tool call.
    const sessionExpiredError = new Error(
      "Tonal session expired — please reconnect at /connect-tonal",
    );
    // Simulate withTokenRetry throwing by having the action context throw.
    // We replace runQuery so withTonalToken fails with the session-expired message.
    const ctx = {
      runQuery: vi.fn().mockRejectedValue(sessionExpiredError),
      runMutation: vi.fn(),
    } as unknown as ActionCtx;

    const result = await fetchHistoryHandler(ctx, {
      userId: "user-123",
      limit: 20,
    });

    expect(result).toEqual([]);
  });

  it("re-throws non-session-expired errors so real failures surface", async () => {
    const networkError = new Error("ECONNREFUSED");
    const ctx = {
      runQuery: vi.fn().mockRejectedValue(networkError),
      runMutation: vi.fn(),
    } as unknown as ActionCtx;

    await expect(fetchHistoryHandler(ctx, { userId: "user-123", limit: 20 })).rejects.toThrow(
      "ECONNREFUSED",
    );
  });
});

describe("fetchWorkoutHistoryPage session-expiry resilience", () => {
  it("returns empty page result instead of throwing when session is expired", async () => {
    const sessionExpiredError = new Error(
      "Tonal session expired — please reconnect at /connect-tonal",
    );
    const ctx = {
      runQuery: vi.fn().mockRejectedValue(sessionExpiredError),
      runMutation: vi.fn(),
    } as unknown as ActionCtx;

    const result = await fetchPageHandler(ctx, { userId: "user-123", offset: 0 });

    expect(result).toEqual({ activities: [], pageSize: 0, pgTotal: 0 });
  });

  it("re-throws non-session-expired errors", async () => {
    const networkError = new Error("upstream timeout");
    const ctx = {
      runQuery: vi.fn().mockRejectedValue(networkError),
      runMutation: vi.fn(),
    } as unknown as ActionCtx;

    await expect(fetchPageHandler(ctx, { userId: "user-123", offset: 0 })).rejects.toThrow(
      "upstream timeout",
    );
  });
});
