import { type FunctionReference, getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { disconnectMyStrava, type DisconnectStravaResult } from "./disconnect";
import {
  completeStravaOAuth,
  type CompleteStravaOAuthResult,
  startStravaOAuth,
  type StartStravaOAuthResult,
  sweepExpiredOauthArtifacts,
} from "./oauthFlow";

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;
type CompleteHandler = (
  ctx: ActionCtx,
  args: { ticket: string },
) => Promise<CompleteStravaOAuthResult>;
type DisconnectHandler = (ctx: ActionCtx, args: object) => Promise<DisconnectStravaResult>;
type StartHandler = (ctx: ActionCtx, args: object) => Promise<StartStravaOAuthResult>;
type SweepHandler = (ctx: ActionCtx, args: object) => Promise<number>;

const completeHandler = (completeStravaOAuth as unknown as { _handler: CompleteHandler })._handler;
const disconnectHandler = (disconnectMyStrava as unknown as { _handler: DisconnectHandler })
  ._handler;
const startHandler = (startStravaOAuth as unknown as { _handler: StartHandler })._handler;
const sweepHandler = (sweepExpiredOauthArtifacts as unknown as { _handler: SweepHandler })._handler;

function localFunctionName(ref: TestFunctionReference): string | null {
  try {
    return getFunctionName(ref);
  } catch {
    return null;
  }
}

describe("Strava OAuth action boundaries", () => {
  const userId = "user-1" as Id<"users">;
  const ticket = "strava-callback-ticket-123";
  const originalEnv = {
    clientId: process.env.STRAVA_CLIENT_ID,
    clientSecret: process.env.STRAVA_CLIENT_SECRET,
    callbackUrl: process.env.STRAVA_OAUTH_CALLBACK_URL,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  };

  beforeEach(() => {
    process.env.STRAVA_CLIENT_ID = "client-id";
    process.env.STRAVA_CLIENT_SECRET = "client-secret";
    process.env.STRAVA_OAUTH_CALLBACK_URL = "https://example.com/strava/callback";
    process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const values = {
      STRAVA_CLIENT_ID: originalEnv.clientId,
      STRAVA_CLIENT_SECRET: originalEnv.clientSecret,
      STRAVA_OAUTH_CALLBACK_URL: originalEnv.callbackUrl,
      TOKEN_ENCRYPTION_KEY: originalEnv.encryptionKey,
    };
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns a stable error when OAuth initiation is rate limited", async () => {
    const ctx = {
      runQuery: vi.fn(async (ref: TestFunctionReference) =>
        localFunctionName(ref) === "lib/auth:resolveEffectiveUserId" ? userId : false,
      ),
      runMutation: vi.fn(async () => {
        throw new ConvexError({ kind: "RateLimited", retryAfter: 30_000 });
      }),
    } as unknown as ActionCtx;

    await expect(startHandler(ctx, {})).resolves.toEqual({
      success: false,
      error: "Too many Strava connection attempts. Please wait a minute and try again.",
    });
  });

  it("rejects OAuth completion before claiming a ticket when unauthenticated", async () => {
    const ctx = {
      runQuery: vi.fn(async () => null),
      runMutation: vi.fn(),
    } as unknown as ActionCtx;

    await expect(completeHandler(ctx, { ticket })).resolves.toEqual({
      success: false,
      error: "Not authenticated",
    });
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("rejects malformed callback tickets before reading authentication", async () => {
    const ctx = {
      runQuery: vi.fn(),
      runMutation: vi.fn(),
    } as unknown as ActionCtx;

    await expect(completeHandler(ctx, { ticket: "short" })).resolves.toEqual({
      success: false,
      error: "Invalid or expired Strava callback ticket",
    });
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("does not claim a callback ticket when OAuth completion is rate limited", async () => {
    const ctx = {
      runQuery: vi.fn(async (ref: TestFunctionReference) =>
        localFunctionName(ref) === "lib/auth:resolveEffectiveUserId" ? userId : false,
      ),
      runMutation: vi.fn(async () => {
        throw new ConvexError({ kind: "RateLimited", retryAfter: 30_000 });
      }),
    } as unknown as ActionCtx;

    await expect(completeHandler(ctx, { ticket })).resolves.toEqual({
      success: false,
      error: "Too many Strava completion attempts. Try again later.",
    });
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
  });

  it("rejects unauthenticated disconnects before claiming credentials", async () => {
    const ctx = {
      runQuery: vi.fn(async () => null),
      runMutation: vi.fn(),
    } as unknown as ActionCtx;

    await expect(disconnectHandler(ctx, {})).rejects.toThrow("Not authenticated");
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("does not claim credentials when disconnect is rate limited", async () => {
    const ctx = {
      runQuery: vi.fn(async () => userId),
      runMutation: vi.fn(async () => {
        throw new ConvexError({ kind: "RateLimited", retryAfter: 30_000 });
      }),
    } as unknown as ActionCtx;

    await expect(disconnectHandler(ctx, {})).rejects.toThrow("Too many Strava disconnect attempts");
    expect(ctx.runMutation).toHaveBeenCalledTimes(1);
  });
});

describe("Strava OAuth artifact sweeping", () => {
  it("reschedules when a bounded batch has more work", async () => {
    const runMutation = vi.fn(async () => ({ deleted: 100, hasMore: true }));
    const runAfter = vi.fn<
      (delayMs: number, ref: TestFunctionReference, args: object) => Promise<string>
    >(async () => "scheduled-id");
    const ctx = {
      runMutation,
      scheduler: { runAfter },
    } as unknown as ActionCtx;

    await expect(sweepHandler(ctx, {})).resolves.toBe(100);
    expect(runAfter).toHaveBeenCalledTimes(1);
    expect(runAfter.mock.calls[0]?.[0]).toBe(0);
    expect(localFunctionName(runAfter.mock.calls[0]?.[1] as TestFunctionReference)).toBe(
      "strava/oauthFlow:sweepExpiredOauthArtifacts",
    );
  });

  it("stops when the bounded batch is drained", async () => {
    const runMutation = vi.fn(async () => ({ deleted: 4, hasMore: false }));
    const runAfter = vi.fn<
      (delayMs: number, ref: TestFunctionReference, args: object) => Promise<string>
    >(async () => "scheduled-id");
    const ctx = {
      runMutation,
      scheduler: { runAfter },
    } as unknown as ActionCtx;

    await expect(sweepHandler(ctx, {})).resolves.toBe(4);
    expect(runAfter).not.toHaveBeenCalled();
  });
});
