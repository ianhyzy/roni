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

describe("Strava disconnect coordination", () => {
  it("waits while an OAuth completion owns the user's callback ticket", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.run(async (ctx) =>
      ctx.db.insert("stravaOauthCallbackTickets", {
        userId,
        ticketHash: "ticket-hash",
        authorizationCodeEncrypted: "encrypted-code",
        acceptedScopes: ["activity:read"],
        completionNonce: "completion-nonce",
        createdAt: 1_000,
        expiresAt: 2_000,
      }),
    );

    await expect(
      t.mutation(internal.strava.connections.claimDisconnect, {
        userId,
        reason: "user_disconnected",
        now: 1_500,
      }),
    ).resolves.toEqual({ state: "leased", retryAfterMs: 500 });
  });

  it("cancels unclaimed OAuth artifacts before reporting no connection", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.run(async (ctx) => {
      await ctx.db.insert("stravaOauthStates", {
        userId,
        stateHash: "state-hash",
        createdAt: 1_000,
        expiresAt: 2_000,
      });
      await ctx.db.insert("stravaOauthCallbackTickets", {
        userId,
        ticketHash: "ticket-hash",
        authorizationCodeEncrypted: "encrypted-code",
        acceptedScopes: ["activity:read"],
        createdAt: 1_000,
        expiresAt: 2_000,
      });
    });

    await expect(
      t.mutation(internal.strava.connections.claimDisconnect, {
        userId,
        reason: "user_disconnected",
        now: 1_500,
      }),
    ).resolves.toBeNull();
    const artifacts = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.query("stravaOauthStates").take(1),
        ctx.db.query("stravaOauthCallbackTickets").take(1),
      ]),
    );
    expect(artifacts).toEqual([[], []]);
  });
});
