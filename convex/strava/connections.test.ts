/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../strava/${key.slice(2)}` : key] = value;
}

async function createUser(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return t.run(async (ctx) => ctx.db.insert("users", {}));
}

async function connect(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  options: { athleteId?: string; generation?: string; tokenExpiresAt?: number } = {},
) {
  return t.mutation(internal.strava.connections.upsertActiveConnection, {
    userId,
    athleteId: options.athleteId ?? "athlete-1",
    generation: options.generation ?? "generation-1",
    accessTokenEncrypted: "encrypted-access-1",
    refreshTokenEncrypted: "encrypted-refresh-1",
    tokenExpiresAt: options.tokenExpiresAt ?? 2_000,
    scopes: ["read", "activity:read", "activity:write"],
    refreshDueAt: 1_500,
    now: 1_000,
  });
}

describe("Strava connections", () => {
  it("durably schedules the first sync with connection persistence", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);

    await connect(t, userId);

    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.name).toBe("strava/sync:runInitialSync");
    expect(JSON.stringify(scheduled[0]?.args)).toContain('"attempt":1');
  });

  it("rejects linking one active athlete to two Roni users", async () => {
    const t = convexTest(schema, modules);
    const firstUserId = await createUser(t);
    const secondUserId = await createUser(t);
    await connect(t, firstUserId);

    await expect(connect(t, secondUserId)).rejects.toThrow(
      "This Strava account is already connected to another Roni account",
    );
  });

  it("reconnects with a new generation and exposes only safe owner status", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    const otherUserId = await createUser(t);
    await connect(t, userId, { generation: "generation-old" });
    await t.mutation(internal.strava.connections.claimDisconnect, {
      userId,
      reason: "user_disconnected",
      now: 1_001,
    });
    await expect(
      connect(t, userId, { athleteId: "athlete-2", generation: "generation-new" }),
    ).resolves.toMatchObject({ replacedGeneration: "generation-old" });

    await expect(
      t
        .withIdentity({ subject: `${userId}|session` })
        .query(api.strava.status.getMyStravaStatus, {}),
    ).resolves.toEqual({
      state: "active",
      connectedAt: 1_000,
      scopes: ["activity:read"],
    });
    await expect(
      t
        .withIdentity({ subject: `${otherUserId}|session` })
        .query(api.strava.status.getMyStravaStatus, {}),
    ).resolves.toEqual({ state: "none" });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("stravaConnections")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique(),
    );
    expect(row).toMatchObject({ athleteId: "athlete-2", generation: "generation-new" });
    expect(row?.scopes).toEqual(["activity:read"]);
  });

  it("requires an explicit disconnect before replacing an active connection", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);

    await expect(connect(t, userId, { generation: "generation-new" })).rejects.toThrow(
      "This Strava account is already connected to your Roni account",
    );
    await expect(
      connect(t, userId, { athleteId: "athlete-2", generation: "generation-new" }),
    ).rejects.toThrow("Disconnect your current Strava account before connecting another");
  });

  it("allows only one refresh lease for a token version", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);

    for (const stale of [
      { generation: "stale-generation", expectedTokenExpiresAt: 2_000 },
      { generation: "generation-1", expectedTokenExpiresAt: 1_999 },
    ]) {
      await expect(
        t.mutation(internal.strava.connections.acquireRefreshLease, {
          userId,
          ...stale,
          leaseNonce: "stale-lease",
          now: 1_100,
          leaseExpiresAt: 1_500,
        }),
      ).resolves.toEqual({ state: "changed" });
    }

    await expect(
      t.mutation(internal.strava.connections.acquireRefreshLease, {
        userId,
        generation: "generation-1",
        expectedTokenExpiresAt: 2_000,
        leaseNonce: "lease-a",
        now: 1_100,
        leaseExpiresAt: 1_500,
      }),
    ).resolves.toEqual({
      state: "acquired",
      refreshTokenEncrypted: "encrypted-refresh-1",
    });
    await expect(
      t.mutation(internal.strava.connections.acquireRefreshLease, {
        userId,
        generation: "generation-1",
        expectedTokenExpiresAt: 2_000,
        leaseNonce: "lease-b",
        now: 1_200,
        leaseExpiresAt: 1_600,
      }),
    ).resolves.toEqual({ state: "leased", retryAfterMs: 300 });
  });

  it("persists only the lease owner with matching generation and expiry", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    await t.mutation(internal.strava.connections.acquireRefreshLease, {
      userId,
      generation: "generation-1",
      expectedTokenExpiresAt: 2_000,
      leaseNonce: "lease-a",
      now: 1_100,
      leaseExpiresAt: 1_500,
    });
    const args = {
      userId,
      generation: "generation-1",
      expectedTokenExpiresAt: 2_000,
      accessTokenEncrypted: "encrypted-access-2",
      refreshTokenEncrypted: "encrypted-refresh-2",
      tokenExpiresAt: 3_000,
      refreshDueAt: 2_500,
    };

    await expect(
      t.mutation(internal.strava.connections.persistRefreshedTokens, {
        ...args,
        leaseNonce: "wrong-lease",
      }),
    ).resolves.toEqual({ state: "changed" });
    await expect(
      t.mutation(internal.strava.connections.persistRefreshedTokens, {
        ...args,
        leaseNonce: "lease-a",
      }),
    ).resolves.toEqual({ state: "persisted" });

    const active = await t.query(internal.strava.connections.getActiveConnectionByUserId, {
      userId,
    });
    expect(active).toMatchObject({
      accessTokenEncrypted: "encrypted-access-2",
      refreshTokenEncrypted: "encrypted-refresh-2",
      tokenExpiresAt: 3_000,
    });
    expect(active).not.toHaveProperty("refreshLeaseNonce");
  });

  it("rejects a stale lease after takeover and keeps the latest rotated token", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    await t.mutation(internal.strava.connections.acquireRefreshLease, {
      userId,
      generation: "generation-1",
      expectedTokenExpiresAt: 2_000,
      leaseNonce: "stale-lease",
      now: 1_100,
      leaseExpiresAt: 1_500,
    });
    await t.mutation(internal.strava.connections.acquireRefreshLease, {
      userId,
      generation: "generation-1",
      expectedTokenExpiresAt: 2_000,
      leaseNonce: "latest-lease",
      now: 1_501,
      leaseExpiresAt: 1_900,
    });
    const tokens = {
      userId,
      generation: "generation-1",
      expectedTokenExpiresAt: 2_000,
      tokenExpiresAt: 3_000,
      refreshDueAt: 2_500,
    };

    await expect(
      t.mutation(internal.strava.connections.persistRefreshedTokens, {
        ...tokens,
        leaseNonce: "stale-lease",
        accessTokenEncrypted: "discarded-access",
        refreshTokenEncrypted: "discarded-refresh",
      }),
    ).resolves.toEqual({ state: "changed" });
    await expect(
      t.mutation(internal.strava.connections.persistRefreshedTokens, {
        ...tokens,
        leaseNonce: "latest-lease",
        accessTokenEncrypted: "latest-access",
        refreshTokenEncrypted: "latest-refresh",
      }),
    ).resolves.toEqual({ state: "persisted" });
    await expect(
      t.query(internal.strava.connections.getActiveConnectionByUserId, { userId }),
    ).resolves.toMatchObject({
      accessTokenEncrypted: "latest-access",
      refreshTokenEncrypted: "latest-refresh",
    });
  });

  it("disconnects locally and removes all credentials and lease state", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    await t.mutation(internal.strava.connections.acquireRefreshLease, {
      userId,
      generation: "generation-1",
      expectedTokenExpiresAt: 2_000,
      leaseNonce: "lease-a",
      now: 1_100,
      leaseExpiresAt: 1_500,
    });

    await expect(
      t.mutation(internal.strava.connections.claimDisconnect, {
        userId,
        reason: "user_disconnected",
        now: 1_500,
      }),
    ).resolves.toEqual({
      state: "claimed",
      generation: "generation-1",
      accessTokenEncrypted: "encrypted-access-1",
    });
    const row = await t.run(async (ctx) => ctx.db.query("stravaConnections").unique());
    expect(row).toMatchObject({ status: "disconnected", disconnectedAt: 1_500 });
    expect(row).not.toHaveProperty("accessTokenEncrypted");
    expect(row).not.toHaveProperty("refreshTokenEncrypted");
    expect(row).not.toHaveProperty("refreshLeaseNonce");
  });

  it("waits for an active refresh lease before disconnecting", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    await t.mutation(internal.strava.connections.acquireRefreshLease, {
      userId,
      generation: "generation-1",
      expectedTokenExpiresAt: 2_000,
      leaseNonce: "lease-a",
      now: 1_100,
      leaseExpiresAt: 1_500,
    });

    await expect(
      t.mutation(internal.strava.connections.claimDisconnect, {
        userId,
        reason: "user_disconnected",
        now: 1_200,
      }),
    ).resolves.toEqual({ state: "leased", retryAfterMs: 300 });
    await expect(
      t.mutation(internal.strava.connections.claimDisconnect, {
        userId,
        reason: "user_disconnected",
        now: 1_500,
      }),
    ).resolves.toMatchObject({ state: "claimed", generation: "generation-1" });
  });

  it("abandons only the exact failed refresh lease and strips credentials", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    await t.mutation(internal.strava.connections.acquireRefreshLease, {
      userId,
      generation: "generation-1",
      expectedTokenExpiresAt: 2_000,
      leaseNonce: "lease-a",
      now: 1_100,
      leaseExpiresAt: 1_500,
    });

    await expect(
      t.mutation(internal.strava.connections.abandonRefresh, {
        userId,
        generation: "generation-1",
        expectedTokenExpiresAt: 2_000,
        leaseNonce: "wrong-lease",
        now: 1_200,
      }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internal.strava.connections.abandonRefresh, {
        userId,
        generation: "generation-1",
        expectedTokenExpiresAt: 2_000,
        leaseNonce: "lease-a",
        now: 1_200,
      }),
    ).resolves.toBe(true);
    const row = await t.run(async (ctx) => ctx.db.query("stravaConnections").unique());
    expect(row).toMatchObject({ status: "disconnected", disconnectReason: "token_invalid" });
    expect(row).not.toHaveProperty("accessTokenEncrypted");
    expect(row).not.toHaveProperty("refreshTokenEncrypted");
  });

  it("blocks connection persistence after account deletion begins", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await t.run(async (ctx) => ctx.db.patch(userId, { deletionInProgress: true }));

    await expect(connect(t, userId)).rejects.toThrow("Account deletion is in progress");
  });

  it("blocks a new refresh lease after account deletion begins", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    await t.run(async (ctx) => ctx.db.patch(userId, { deletionInProgress: true }));

    await expect(
      t.mutation(internal.strava.connections.acquireRefreshLease, {
        userId,
        generation: "generation-1",
        expectedTokenExpiresAt: 2_000,
        leaseNonce: "lease-after-deletion",
        now: 1_100,
        leaseExpiresAt: 1_500,
      }),
    ).resolves.toEqual({ state: "changed" });
  });
});
