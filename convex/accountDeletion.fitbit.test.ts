/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { revokeFitbitTokenWithRetry } from "./fitbit/sync";

const modules = import.meta.glob("./**/*.*s");

test("account deletion drains Fitbit credentials, OAuth state, and wellness by user", async () => {
  const t = convexTest(schema, modules);
  const [userId, otherUserId] = await t.run(async (ctx) => [
    await ctx.db.insert("users", {}),
    await ctx.db.insert("users", {}),
  ]);
  await t.run(async (ctx) => {
    for (const [owner, suffix] of [
      [userId, "target"],
      [otherUserId, "other"],
    ] as const) {
      await ctx.db.insert("fitbitConnections", {
        userId: owner,
        healthUserId: `health-${suffix}`,
        generation: `generation-${suffix}`,
        status: "active",
        accessTokenEncrypted: `access-${suffix}`,
        refreshTokenEncrypted: `refresh-${suffix}`,
        tokenExpiresAt: 2000,
        scopes: ["scope"],
        connectedAt: 1000,
        refreshDueAt: 1500,
      });
      await ctx.db.insert("fitbitOauthStates", {
        userId: owner,
        stateHash: `state-${suffix}`,
        createdAt: 1000,
        expiresAt: 2000,
      });
      await ctx.db.insert("fitbitOauthCallbackTickets", {
        userId: owner,
        ticketHash: `ticket-${suffix}`,
        authorizationCodeEncrypted: `code-${suffix}`,
        createdAt: 1000,
        expiresAt: 2000,
      });
      await ctx.db.insert("fitbitWellnessDaily", {
        userId: owner,
        generation: `generation-${suffix}`,
        calendarDate: "2026-07-28",
        restingHeartRate: 54,
        lastIngestedAt: 1000,
      });
    }
  });

  for (const table of [
    "fitbitConnections",
    "fitbitOauthStates",
    "fitbitOauthCallbackTickets",
    "fitbitWellnessDaily",
  ] as const) {
    await t.mutation(internal.accountDeletion.deleteUserTableBatch, { userId, table });
  }

  const counts = await t.run(async (ctx) => ({
    connections: await ctx.db.query("fitbitConnections").collect(),
    states: await ctx.db.query("fitbitOauthStates").collect(),
    tickets: await ctx.db.query("fitbitOauthCallbackTickets").collect(),
    wellness: await ctx.db.query("fitbitWellnessDaily").collect(),
  }));
  expect(counts.connections.map((row) => row.userId)).toEqual([otherUserId]);
  expect(counts.states.map((row) => row.userId)).toEqual([otherUserId]);
  expect(counts.tickets.map((row) => row.userId)).toEqual([otherUserId]);
  expect(counts.wellness.map((row) => row.userId)).toEqual([otherUserId]);
});

test("Fitbit account-deletion revocation retries transient failures and resolves safely", async () => {
  const transientThenSuccess = vi
    .fn<(input: string, init: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));

  await expect(revokeFitbitTokenWithRetry("secret-token", transientThenSuccess)).resolves.toBe(
    true,
  );
  expect(transientThenSuccess).toHaveBeenCalledTimes(3);

  const permanentFailure = vi
    .fn<(input: string, init: RequestInit) => Promise<Response>>()
    .mockResolvedValue(new Response(null, { status: 503 }));
  await expect(revokeFitbitTokenWithRetry("secret-token", permanentFailure)).resolves.toBe(false);
  expect(permanentFailure).toHaveBeenCalledTimes(3);
});
