/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? `../fitbit/${key.slice(2)}` : key] = value;
}

async function createUser(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => ctx.db.insert("users", {}));
}

describe("Fitbit OAuth artifacts", () => {
  it("exchanges OAuth state for a ticket claimed once by the bound user", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    const otherUserId = await createUser(t);
    await t.mutation(internal.fitbit.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "hash-1",
      now: 1000,
    });

    await expect(
      t.mutation(internal.fitbit.oauthArtifacts.exchangeOauthStateForTicket, {
        stateHash: "hash-1",
        ticketHash: "ticket-hash-1",
        authorizationCodeEncrypted: "encrypted-code",
        now: 1001,
      }),
    ).resolves.toBe(true);
    await expect(
      t.mutation(internal.fitbit.oauthArtifacts.claimOauthCallbackTicket, {
        userId: otherUserId,
        ticketHash: "ticket-hash-1",
        now: 1002,
      }),
    ).resolves.toBeNull();
    await expect(
      t.mutation(internal.fitbit.oauthArtifacts.claimOauthCallbackTicket, {
        userId,
        ticketHash: "ticket-hash-1",
        now: 1003,
      }),
    ).resolves.toBe("encrypted-code");
    await expect(
      t.mutation(internal.fitbit.oauthArtifacts.claimOauthCallbackTicket, {
        userId,
        ticketHash: "ticket-hash-1",
        now: 1004,
      }),
    ).resolves.toBeNull();
  });

  it("rejects an OAuth state at its exact expiration time", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await t.mutation(internal.fitbit.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "expired-hash",
      now: 1_000,
    });

    const firstClaim = await t.mutation(
      internal.fitbit.oauthArtifacts.exchangeOauthStateForTicket,
      {
        stateHash: "expired-hash",
        ticketHash: "ticket-1",
        authorizationCodeEncrypted: "code-1",
        now: 15 * 60 * 1_000 + 1_000,
      },
    );
    const repeatedClaim = await t.mutation(
      internal.fitbit.oauthArtifacts.exchangeOauthStateForTicket,
      {
        stateHash: "expired-hash",
        ticketHash: "ticket-2",
        authorizationCodeEncrypted: "code-2",
        now: 15 * 60 * 1_000 + 1_001,
      },
    );

    expect(firstClaim).toBe(false);
    expect(repeatedClaim).toBe(false);
  });

  it("rejects an OAuth callback ticket at its exact expiration time", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await t.mutation(internal.fitbit.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "state-hash",
      now: 1_000,
    });
    await t.mutation(internal.fitbit.oauthArtifacts.exchangeOauthStateForTicket, {
      stateHash: "state-hash",
      ticketHash: "ticket-hash",
      authorizationCodeEncrypted: "encrypted-code",
      now: 2_000,
    });

    await expect(
      t.mutation(internal.fitbit.oauthArtifacts.claimOauthCallbackTicket, {
        userId,
        ticketHash: "ticket-hash",
        now: 15 * 60 * 1_000 + 2_000,
      }),
    ).resolves.toBeNull();
  });

  it("keeps only one outstanding OAuth state per user", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await t.mutation(internal.fitbit.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "old-state",
      now: 1000,
    });
    await t.mutation(internal.fitbit.oauthArtifacts.saveOauthState, {
      userId,
      stateHash: "new-state",
      now: 1001,
    });

    const states = await t.run(async (ctx) =>
      ctx.db
        .query("fitbitOauthStates")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(states.map((row) => row.stateHash)).toEqual(["new-state"]);
  });
});
