import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FunctionReference, getFunctionName } from "convex/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { CACHE_TTLS } from "./cache";
import { TonalApiError } from "./client";
import { connectTonal, type ConnectTonalResult } from "./connect";
import { decryptToken } from "./auth";
import type { TonalUser } from "./types";

const TEST_KEY = "a".repeat(64);
const NOW = Date.parse("2026-07-28T18:00:00.000Z");
const TOKEN_EXPIRES_AT = Date.parse("2026-07-29T18:00:00.000Z");
const USER_ID = "user-1" as Id<"users">;
const TONAL_EMAIL = "ada@example.com";
const TONAL_PASSWORD = "correct horse battery staple";
const ID_TOKEN = `header.${btoa(
  JSON.stringify({ exp: TOKEN_EXPIRES_AT / 1000, marker: "\u0080\u00be\u0083\u00f0" }),
)
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "")}.signature`;
const REFRESH_TOKEN = "refresh-token";

const TONAL_PROFILE: TonalUser = {
  id: "tonal-user-1",
  email: TONAL_EMAIL,
  firstName: "Ada",
  lastName: "Lovelace",
  gender: "female",
  heightInches: 65,
  weightPounds: 135,
  auth0Id: "auth0|ada",
  dateOfBirth: "1990-12-10",
  username: "ada",
  workoutsPerWeek: 4,
  workoutDurationMin: 30,
  workoutDurationMax: 45,
  tonalStatus: "advanced",
  accountType: "member",
  location: "Denver",
  createdAt: "2024-01-02T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;

type ConnectHandler = (
  ctx: ActionCtx,
  args: { userId: Id<"users">; tonalEmail: string; tonalPassword: string },
) => Promise<ConnectTonalResult>;

const handler = (connectTonal as unknown as { _handler: ConnectHandler })._handler;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeContext() {
  const runQuery = vi.fn(async (ref: TestFunctionReference) => {
    const name = getFunctionName(ref);
    if (name === "tonal/movementSync:getAllMovements") return [{ id: "movement-1" }];
    throw new Error(`Unexpected query: ${name}`);
  });
  const runMutation = vi.fn(
    async (_ref: TestFunctionReference, _args: Record<string, unknown>) => null,
  );
  const runAction = vi.fn(
    async (_ref: TestFunctionReference, _args: Record<string, unknown>) => null,
  );
  const ctx = { runQuery, runMutation, runAction } as unknown as ActionCtx;

  return { ctx, runQuery, runMutation, runAction };
}

function functionNames(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map(([ref]) => getFunctionName(ref as TestFunctionReference));
}

function stubSuccessfulNetwork() {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://tonal.auth0.com/oauth/token") {
      return jsonResponse({ id_token: ID_TOKEN, refresh_token: REFRESH_TOKEN });
    }
    if (url === "https://api.tonal.com/v6/users/userinfo") {
      return jsonResponse(TONAL_PROFILE);
    }
    throw new Error(`Unexpected network request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("connectTonal wire contract", () => {
  const originalEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  const originalDiscordWebhook = process.env.DISCORD_WEBHOOK_URL;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    delete process.env.DISCORD_WEBHOOK_URL;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
    if (originalDiscordWebhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = originalDiscordWebhook;
  });

  it("fetches userinfo and wires the profile, cache, notification, and backfill", async () => {
    const fetchMock = stubSuccessfulNetwork();
    const { ctx, runQuery, runMutation, runAction } = makeContext();

    const result = await handler(ctx, {
      userId: USER_ID,
      tonalEmail: TONAL_EMAIL,
      tonalPassword: TONAL_PASSWORD,
    });

    expect(result).toEqual({ success: true, tonalUserId: TONAL_PROFILE.id });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://tonal.auth0.com/oauth/token",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(`"username":"${TONAL_EMAIL}"`),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.tonal.com/v6/users/userinfo",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: `Bearer ${ID_TOKEN}` }),
      }),
    );
    expect(functionNames(runQuery)).toEqual(["tonal/movementSync:getAllMovements"]);
    expect(functionNames(runMutation)).toEqual([
      "userProfiles:create",
      "tonal/cache:setCacheEntry",
      "tonal/historySync:startBackfillUserHistory",
    ]);
    expect(functionNames(runAction)).toEqual(["discord:notifyTonalConnection"]);

    const createArgs = runMutation.mock.calls[0][1];
    expect(createArgs).toMatchObject({
      userId: USER_ID,
      tonalUserId: TONAL_PROFILE.id,
      tonalEmail: TONAL_EMAIL,
      tonalTokenExpiresAt: TOKEN_EXPIRES_AT,
      profileData: {
        firstName: "Ada",
        lastName: "Lovelace",
        heightInches: 65,
        weightPounds: 135,
        gender: "female",
        level: "advanced",
        workoutsPerWeek: 4,
        workoutDurationMin: 30,
        workoutDurationMax: 45,
        dateOfBirth: "1990-12-10",
        username: "ada",
        tonalCreatedAt: "2024-01-02T00:00:00.000Z",
      },
    });
    const encryptedToken = createArgs.tonalToken;
    const encryptedRefreshToken = createArgs.tonalRefreshToken;
    expect(typeof encryptedToken).toBe("string");
    expect(typeof encryptedRefreshToken).toBe("string");
    if (typeof encryptedToken !== "string" || typeof encryptedRefreshToken !== "string") {
      throw new Error("connectTonal did not persist encrypted Tonal tokens");
    }
    await expect(decryptToken(encryptedToken, TEST_KEY)).resolves.toBe(ID_TOKEN);
    await expect(decryptToken(encryptedRefreshToken, TEST_KEY)).resolves.toBe(REFRESH_TOKEN);

    expect(runMutation.mock.calls[1][1]).toEqual({
      userId: USER_ID,
      dataType: "profile",
      data: TONAL_PROFILE,
      fetchedAt: NOW,
      expiresAt: NOW + CACHE_TTLS.profile,
    });
    expect(runAction).toHaveBeenCalledWith(internal.discord.notifyTonalConnection, {
      email: TONAL_EMAIL,
      tonalName: "Ada Lovelace",
    });
    expect(runMutation).toHaveBeenLastCalledWith(
      internal.tonal.historySync.startBackfillUserHistory,
      { userId: USER_ID },
    );
  });

  it("returns invalid_credentials without fetching or persisting a profile", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error_description: "Wrong email or password." }, 401),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, runQuery, runMutation, runAction } = makeContext();

    const result = await handler(ctx, {
      userId: USER_ID,
      tonalEmail: TONAL_EMAIL,
      tonalPassword: "wrong-password",
    });

    expect(result).toEqual({ success: false, error: "invalid_credentials" });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
  });

  it("propagates a userinfo API failure before any Convex side effects", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === "https://tonal.auth0.com/oauth/token") {
        return jsonResponse({ id_token: ID_TOKEN, refresh_token: REFRESH_TOKEN });
      }
      return new Response("Unavailable", { status: 503 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { ctx, runQuery, runMutation, runAction } = makeContext();

    const error: unknown = await handler(ctx, {
      userId: USER_ID,
      tonalEmail: TONAL_EMAIL,
      tonalPassword: TONAL_PASSWORD,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TonalApiError);
    expect(error).toMatchObject({ status: 503, body: "Unavailable" });
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
  });

  it("rejects a connection before persistence when token encryption is not configured", async () => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const fetchMock = stubSuccessfulNetwork();
    const { ctx, runQuery, runMutation, runAction } = makeContext();

    await expect(
      handler(ctx, {
        userId: USER_ID,
        tonalEmail: TONAL_EMAIL,
        tonalPassword: TONAL_PASSWORD,
      }),
    ).rejects.toThrow("TOKEN_ENCRYPTION_KEY env var is not set");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
    expect(runAction).not.toHaveBeenCalled();
  });
});
