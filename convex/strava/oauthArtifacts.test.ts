/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../strava/${key.slice(2)}` : key] = value;
}

async function createUser(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.insert("users", {}));
}

describe("Strava OAuth artifacts", () => {
  it("exchanges state for an owner-bound ticket that can be claimed once", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    const otherUserId = await createUser(t);
    await t.mutation(internal.strava.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "state-hash",
      now: 1_000,
    });
    await expect(
      t.mutation(internal.strava.oauthArtifacts.exchangeOauthStateForTicket, {
        stateHash: "state-hash",
        ticketHash: "ticket-hash",
        authorizationCodeEncrypted: "encrypted-code",
        acceptedScopes: ["activity:read"],
        now: 1_001,
      }),
    ).resolves.toBe(true);

    await expect(
      t.mutation(internal.strava.oauthArtifacts.claimOauthCallbackTicket, {
        userId: otherUserId,
        ticketHash: "ticket-hash",
        completionNonce: "other-completion",
        now: 1_002,
      }),
    ).resolves.toBeNull();
    await expect(
      t.mutation(internal.strava.oauthArtifacts.claimOauthCallbackTicket, {
        userId,
        ticketHash: "ticket-hash",
        completionNonce: "completion-1",
        now: 1_003,
      }),
    ).resolves.toEqual({
      state: "claimed",
      artifact: {
        authorizationCodeEncrypted: "encrypted-code",
        acceptedScopes: ["activity:read"],
      },
    });
    await expect(
      t.mutation(internal.strava.oauthArtifacts.claimOauthCallbackTicket, {
        userId,
        ticketHash: "ticket-hash",
        completionNonce: "completion-2",
        now: 1_004,
      }),
    ).resolves.toBeNull();
  });

  it("accepts state before expiration and consumes it at exact expiration", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await t.mutation(internal.strava.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "unexpired-state",
      now: 1_000,
    });

    await expect(
      t.mutation(internal.strava.oauthArtifacts.exchangeOauthStateForTicket, {
        stateHash: "unexpired-state",
        ticketHash: "unexpired-ticket",
        authorizationCodeEncrypted: "encrypted-code",
        acceptedScopes: ["activity:read"],
        now: 900_999,
      }),
    ).resolves.toBe(true);
    await t.mutation(internal.strava.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "expired-state",
      now: 1_000,
    });
    await expect(
      t.mutation(internal.strava.oauthArtifacts.exchangeOauthStateForTicket, {
        stateHash: "expired-state",
        ticketHash: "expired-ticket",
        authorizationCodeEncrypted: "encrypted-code",
        acceptedScopes: ["activity:read"],
        now: 901_000,
      }),
    ).resolves.toBe(false);
    await expect(
      t.run(async (ctx) =>
        ctx.db
          .query("stravaOauthStates")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .take(1),
      ),
    ).resolves.toEqual([]);
  });

  it("consumes an owner ticket when it expires", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await t.mutation(internal.strava.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "state-hash",
      now: 1_000,
    });
    await t.mutation(internal.strava.oauthArtifacts.exchangeOauthStateForTicket, {
      stateHash: "state-hash",
      ticketHash: "ticket-hash",
      authorizationCodeEncrypted: "encrypted-code",
      acceptedScopes: ["activity:read"],
      now: 2_000,
    });

    await expect(
      t.mutation(internal.strava.oauthArtifacts.claimOauthCallbackTicket, {
        userId,
        ticketHash: "ticket-hash",
        completionNonce: "completion-expired",
        now: 902_000,
      }),
    ).resolves.toBeNull();
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("stravaOauthCallbackTickets")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(2),
    );
    expect(rows).toEqual([]);
  });

  it("blocks a second callback while one completion owns the user lease", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    const otherUserId = await createUser(t);
    await t.mutation(internal.strava.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "state-1",
      now: 1_000,
    });
    await t.mutation(internal.strava.oauthArtifacts.exchangeOauthStateForTicket, {
      stateHash: "state-1",
      ticketHash: "ticket-1",
      authorizationCodeEncrypted: "encrypted-code-1",
      acceptedScopes: ["activity:read"],
      now: 1_001,
    });
    await t.mutation(internal.strava.oauthArtifacts.claimOauthCallbackTicket, {
      userId,
      ticketHash: "ticket-1",
      completionNonce: "completion-1",
      now: 1_002,
    });
    const claimedTicket = await t.run(async (ctx) =>
      ctx.db.query("stravaOauthCallbackTickets").unique(),
    );
    expect(claimedTicket?.expiresAt).toBe(121_002);
    await t.mutation(internal.strava.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "state-2",
      now: 1_003,
    });

    await expect(
      t.mutation(internal.strava.oauthArtifacts.exchangeOauthStateForTicket, {
        stateHash: "state-2",
        ticketHash: "ticket-2",
        authorizationCodeEncrypted: "encrypted-code-2",
        acceptedScopes: ["activity:read"],
        now: 1_004,
      }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internal.strava.oauthArtifacts.releaseOauthCallbackTicket, {
        userId,
        ticketHash: "wrong-ticket",
        completionNonce: "completion-1",
      }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internal.strava.oauthArtifacts.releaseOauthCallbackTicket, {
        userId: otherUserId,
        ticketHash: "ticket-1",
        completionNonce: "completion-1",
      }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internal.strava.oauthArtifacts.releaseOauthCallbackTicket, {
        userId,
        ticketHash: "ticket-1",
        completionNonce: "wrong-completion",
      }),
    ).resolves.toBe(false);
    await expect(
      t.mutation(internal.strava.oauthArtifacts.releaseOauthCallbackTicket, {
        userId,
        ticketHash: "ticket-1",
        completionNonce: "completion-1",
      }),
    ).resolves.toBe(true);
  });

  it("extends a claimed ticket long enough to survive the expiry sweep", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await t.mutation(internal.strava.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "state-near-expiry",
      now: 1_000,
    });
    await t.mutation(internal.strava.oauthArtifacts.exchangeOauthStateForTicket, {
      stateHash: "state-near-expiry",
      ticketHash: "ticket-near-expiry",
      authorizationCodeEncrypted: "encrypted-code",
      acceptedScopes: ["activity:read"],
      now: 1_001,
    });
    await t.mutation(internal.strava.oauthArtifacts.claimOauthCallbackTicket, {
      userId,
      ticketHash: "ticket-near-expiry",
      completionNonce: "completion-near-expiry",
      now: 900_999,
    });

    await expect(
      t.mutation(internal.strava.oauthArtifacts.sweepExpired, { now: 901_000 }),
    ).resolves.toEqual({ deleted: 0, hasMore: false });
    const ticket = await t.run(async (ctx) => ctx.db.query("stravaOauthCallbackTickets").unique());
    expect(ticket?.expiresAt).toBeGreaterThan(901_000);
  });

  it("keeps only the latest outstanding state per user", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await t.mutation(internal.strava.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "old-state",
      now: 1_000,
    });
    await t.mutation(internal.strava.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "new-state",
      now: 1_001,
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("stravaOauthStates")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(2),
    );
    expect(rows.map((row) => row.stateHash)).toEqual(["new-state"]);
  });

  it("sweeps expired artifacts in bounded batches and reports more work", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 101; i += 1) {
        await ctx.db.insert("stravaOauthStates", {
          userId,
          stateHash: `state-${i}`,
          createdAt: 1,
          expiresAt: 2,
        });
      }
    });

    await expect(
      t.mutation(internal.strava.oauthArtifacts.sweepExpired, { now: 2 }),
    ).resolves.toEqual({ deleted: 100, hasMore: true });
    await expect(
      t.mutation(internal.strava.oauthArtifacts.sweepExpired, { now: 2 }),
    ).resolves.toEqual({ deleted: 1, hasMore: false });
  });
});
