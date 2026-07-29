/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../fitbit/${key.slice(2)}` : key] = value;
}

async function createUser(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return t.run(async (ctx) => ctx.db.insert("users", {}));
}

async function connect(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  healthUserId = "health-user-1",
  generation = `generation-${healthUserId}`,
) {
  return t.mutation(internal.fitbit.connections.upsertActiveConnection, {
    userId,
    healthUserId,
    generation,
    accessTokenEncrypted: "access-encrypted",
    refreshTokenEncrypted: "refresh-encrypted",
    tokenExpiresAt: 2_000_000,
    scopes: ["scope-a"],
    refreshDueAt: 1_000_000,
    now: 500_000,
  });
}

describe("Fitbit connections", () => {
  it("rejects linking one active Google Health identity to two users", async () => {
    const t = convexTest(schema, modules);
    const firstUser = await createUser(t);
    const secondUser = await createUser(t);
    await connect(t, firstUser);

    await expect(connect(t, secondUser)).rejects.toThrow(
      "This Fitbit account is already connected to another Roni account",
    );
  });

  it("replaces an active connection with a credential-free disconnected document", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);

    await t.mutation(internal.fitbit.connections.markDisconnected, {
      userId,
      generation: "generation-health-user-1",
      reason: "token_invalid",
      now: 1_500_000,
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("fitbitConnections")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique(),
    );
    expect(row).toMatchObject({
      userId,
      healthUserId: "health-user-1",
      status: "disconnected",
      disconnectReason: "token_invalid",
      disconnectedAt: 1_500_000,
    });
    expect(row).not.toHaveProperty("accessTokenEncrypted");
    expect(row).not.toHaveProperty("refreshTokenEncrypted");
    expect(row).not.toHaveProperty("tokenExpiresAt");
    expect(row).not.toHaveProperty("refreshDueAt");
  });

  it("ignores a stale generation disconnect after relinking", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId, "health-user-1", "generation-old");
    await connect(t, userId, "health-user-2", "generation-new");

    await expect(
      t.mutation(internal.fitbit.connections.markDisconnected, {
        userId,
        generation: "generation-old",
        reason: "token_invalid",
        now: 2_000_000,
      }),
    ).resolves.toBe(false);

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("fitbitConnections")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique(),
    );
    expect(row).toMatchObject({ status: "active", generation: "generation-new" });
  });

  it("disconnects when invalid_grant matches the active token version", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);

    await expect(
      t.mutation(internal.fitbit.connections.markDisconnected, {
        userId,
        generation: "generation-health-user-1",
        reason: "token_invalid",
        now: 1_500_000,
        expectedTokenExpiresAt: 2_000_000,
      }),
    ).resolves.toBe(true);
  });

  it("preserves rotated credentials when invalid_grant came from the previous token", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    await t.mutation(internal.fitbit.connections.replaceTokens, {
      userId,
      generation: "generation-health-user-1",
      accessTokenEncrypted: "access-rotated",
      refreshTokenEncrypted: "refresh-rotated",
      tokenExpiresAt: 3_000_000,
      expectedTokenExpiresAt: 2_000_000,
      scopes: ["scope-a"],
      refreshDueAt: 2_500_000,
    });

    await expect(
      t.mutation(internal.fitbit.connections.markDisconnected, {
        userId,
        generation: "generation-health-user-1",
        reason: "token_invalid",
        now: 1_500_000,
        expectedTokenExpiresAt: 2_000_000,
      }),
    ).resolves.toBe(false);

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("fitbitConnections")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique(),
    );
    expect(row).toMatchObject({
      status: "active",
      tokenExpiresAt: 3_000_000,
      accessTokenEncrypted: "access-rotated",
      refreshTokenEncrypted: "refresh-rotated",
    });
  });

  it("atomically claims the rotated token version when refresh wins the disconnect race", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    await t.mutation(internal.fitbit.connections.replaceTokens, {
      userId,
      generation: "generation-health-user-1",
      accessTokenEncrypted: "access-rotated",
      refreshTokenEncrypted: "refresh-rotated",
      tokenExpiresAt: 3_000_000,
      expectedTokenExpiresAt: 2_000_000,
      scopes: ["scope-a"],
      refreshDueAt: 2_500_000,
    });

    const claimed = await t.mutation(internal.fitbit.connections.claimDisconnect, {
      userId,
      reason: "user_disconnected",
      now: 3_100_000,
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("fitbitConnections")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique(),
    );

    expect(claimed).toEqual({
      generation: "generation-health-user-1",
      refreshTokenEncrypted: "refresh-rotated",
      tokenExpiresAt: 3_000_000,
    });
    expect(row).toMatchObject({
      status: "disconnected",
      generation: "generation-health-user-1",
      disconnectedAt: 3_100_000,
    });
    expect(row).not.toHaveProperty("refreshTokenEncrypted");
  });

  it("removes only the missing data-type scope while another scope remains", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);
    await t.mutation(internal.fitbit.connections.replaceTokens, {
      userId,
      generation: "generation-health-user-1",
      accessTokenEncrypted: "access-2",
      refreshTokenEncrypted: "refresh-2",
      tokenExpiresAt: 3_000_000,
      expectedTokenExpiresAt: 2_000_000,
      scopes: ["scope-a", "scope-b"],
      refreshDueAt: 2_500_000,
    });

    const result = await t.mutation(internal.fitbit.connections.removeGrantedScope, {
      userId,
      generation: "generation-health-user-1",
      scope: "scope-a",
      now: 2_000_000,
    });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("fitbitConnections")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique(),
    );
    expect(result).toEqual({ changed: true, disconnected: false });
    expect(row).toMatchObject({ status: "active", scopes: ["scope-b"] });
  });

  it("leaves the connection unchanged when an unknown scope was never granted", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await connect(t, userId);

    await expect(
      t.mutation(internal.fitbit.connections.removeGrantedScope, {
        userId,
        generation: "generation-health-user-1",
        scope: "unknown-scope",
        now: 2_000_000,
      }),
    ).resolves.toEqual({ changed: false, disconnected: false });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("fitbitConnections")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique(),
    );
    expect(row).toMatchObject({ status: "active", scopes: ["scope-a"] });
  });

  it("claims a bounded due batch without starving remaining connections", async () => {
    const t = convexTest(schema, modules);
    const userIds: Id<"users">[] = [];
    for (let index = 0; index < 26; index += 1) {
      const userId = await createUser(t);
      userIds.push(userId);
      await connect(t, userId, `health-${index}`);
    }

    const firstBatch = await t.mutation(internal.fitbit.connections.claimDueConnections, {
      now: 1_000_001,
      limit: 25,
    });
    const continuationBatch = await t.mutation(internal.fitbit.connections.claimDueConnections, {
      now: 1_000_001,
      limit: 25,
    });

    expect(firstBatch).toHaveLength(25);
    expect(continuationBatch).toHaveLength(1);
    expect(new Set([...firstBatch, ...continuationBatch].map((row) => row.userId))).toEqual(
      new Set(userIds),
    );
    const claimedRow = await t.run(async (ctx) =>
      ctx.db
        .query("fitbitConnections")
        .withIndex("by_userId", (q) => q.eq("userId", firstBatch[0].userId))
        .unique(),
    );
    expect(claimedRow?.status).toBe("active");
    if (claimedRow?.status === "active") {
      expect(claimedRow.refreshDueAt).toBeGreaterThan(1_000_001);
    }
  });
});
