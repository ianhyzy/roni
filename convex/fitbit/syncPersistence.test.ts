import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { encryptFitbitSecret, FITBIT_READ_SCOPES } from "./config";
import { type FitbitSyncResult, syncConnection } from "./sync";

type TestFunctionReference = FunctionReference<
  "query" | "mutation" | "action",
  "public" | "internal"
>;
type SyncHandler = (
  ctx: ActionCtx,
  args: { userId: Id<"users">; generation: string; days: number },
) => Promise<FitbitSyncResult>;

const syncHandler = (syncConnection as unknown as { _handler: SyncHandler })._handler;

describe("sync persistence coordination", () => {
  const now = Date.parse("2026-07-29T12:00:00.000Z");
  const userId = "user-1" as Id<"users">;
  const generation = "generation-1";
  const originalEnv = {
    clientId: process.env.FITBIT_GOOGLE_CLIENT_ID,
    clientSecret: process.env.FITBIT_GOOGLE_CLIENT_SECRET,
    callbackUrl: process.env.FITBIT_GOOGLE_OAUTH_CALLBACK_URL,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env.FITBIT_GOOGLE_CLIENT_ID = "client-id";
    process.env.FITBIT_GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.FITBIT_GOOGLE_OAUTH_CALLBACK_URL = "https://example.com/fitbit/callback";
    process.env.TOKEN_ENCRYPTION_KEY = "ab".repeat(32);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ dataPoints: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [key, value] of Object.entries({
      FITBIT_GOOGLE_CLIENT_ID: originalEnv.clientId,
      FITBIT_GOOGLE_CLIENT_SECRET: originalEnv.clientSecret,
      FITBIT_GOOGLE_OAUTH_CALLBACK_URL: originalEnv.callbackUrl,
      TOKEN_ENCRYPTION_KEY: originalEnv.encryptionKey,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function makeSyncContext(
    scopes: readonly string[],
    rejectedMutation: string,
    throwingMutation?: string,
  ): Promise<{ ctx: ActionCtx; runMutation: ReturnType<typeof vi.fn> }> {
    const accessTokenEncrypted = await encryptFitbitSecret("access-token");
    const runQuery = vi.fn(async (ref: TestFunctionReference) => {
      const name = getFunctionName(ref);
      if (name === "lib/auth:getDeletionInProgress") return false;
      if (name === "fitbit/connections:getActiveConnectionByUserId") {
        return {
          status: "active" as const,
          generation,
          accessTokenEncrypted,
          refreshTokenEncrypted: "unused",
          tokenExpiresAt: now + 24 * 60 * 60 * 1000,
          scopes: [...scopes],
        };
      }
      throw new Error(`Unexpected query: ${name}`);
    });
    const runMutation = vi.fn(async (ref: TestFunctionReference) => {
      const name = getFunctionName(ref);
      if (name === throwingMutation) throw new Error("Persistence unavailable");
      return name !== rejectedMutation;
    });
    return { ctx: { runQuery, runMutation } as unknown as ActionCtx, runMutation };
  }

  it.each([
    {
      label: "activity reconciliation",
      scopes: [FITBIT_READ_SCOPES[0]],
      mutation: "fitbit/activityPersistence:reconcileExternalActivities",
    },
    {
      label: "wellness reconciliation",
      scopes: [FITBIT_READ_SCOPES[1]],
      mutation: "fitbit/wellnessDaily:upsertWellnessDaily",
    },
  ])("fails when $label rejects a stale connection", async ({ scopes, mutation }) => {
    const { ctx, runMutation } = await makeSyncContext(scopes, mutation);

    await expect(syncHandler(ctx, { userId, generation, days: 30 })).resolves.toEqual({
      success: false,
      error: "Fitbit is not connected.",
    });

    const resultWrites = runMutation.mock.calls.filter(
      ([ref]) =>
        getFunctionName(ref as TestFunctionReference) === "fitbit/connections:recordSyncResult",
    );
    expect(resultWrites).toHaveLength(1);
    expect(resultWrites[0]?.[1]).toMatchObject({ error: "Fitbit is not connected." });
  });

  it("does not report success when the final sync result loses the generation race", async () => {
    const { ctx, runMutation } = await makeSyncContext(
      [FITBIT_READ_SCOPES[0]],
      "fitbit/connections:recordSyncResult",
    );

    await expect(syncHandler(ctx, { userId, generation, days: 30 })).resolves.toEqual({
      success: false,
      error: "Fitbit is not connected.",
    });
    const resultWrites = runMutation.mock.calls.filter(
      ([ref]) =>
        getFunctionName(ref as TestFunctionReference) === "fitbit/connections:recordSyncResult",
    );
    expect(resultWrites).toHaveLength(1);
    expect(resultWrites[0]?.[1]).not.toHaveProperty("error");
  });

  it("preserves the public sync error when recording that error fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("upstream credentials and raw details");
      }),
    );
    const { ctx } = await makeSyncContext(
      [FITBIT_READ_SCOPES[0]],
      "unused",
      "fitbit/connections:recordSyncResult",
    );

    await expect(syncHandler(ctx, { userId, generation, days: 30 })).resolves.toEqual({
      success: false,
      error: "Fitbit sync failed.",
    });
  });
});
