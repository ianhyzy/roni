/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const STRAVA_SAFETY_TABLES = [
  "stravaConnections",
  "stravaOauthStates",
  "stravaOauthCallbackTickets",
  "stravaWebhookEvents",
] as const;

describe("Strava orphan repair safety", () => {
  test.each(STRAVA_SAFETY_TABLES)("detects orphan data in %s", async (table) => {
    const t = convexTest(schema, modules);
    const email = `${table}@example.com`;
    const orphanId = await t.run(async (ctx) => {
      await ctx.db.insert("users", { email });
      const duplicateUserId = await ctx.db.insert("users", { email });
      await ctx.db.insert("authAccounts", {
        userId: duplicateUserId,
        provider: "password",
        providerAccountId: email,
        secret: "hashed-secret",
      });

      switch (table) {
        case "stravaConnections":
          await ctx.db.insert("stravaConnections", {
            userId: duplicateUserId,
            athleteId: "athlete-1",
            generation: "generation-1",
            status: "active",
            accessTokenEncrypted: "encrypted-access-token",
            refreshTokenEncrypted: "encrypted-refresh-token",
            tokenExpiresAt: 2_000,
            scopes: ["activity:read"],
            connectedAt: 1_000,
            refreshDueAt: 1_500,
          });
          break;
        case "stravaOauthStates":
          await ctx.db.insert("stravaOauthStates", {
            userId: duplicateUserId,
            stateHash: "state-hash",
            createdAt: 1_000,
            expiresAt: 2_000,
          });
          break;
        case "stravaOauthCallbackTickets":
          await ctx.db.insert("stravaOauthCallbackTickets", {
            userId: duplicateUserId,
            ticketHash: "ticket-hash",
            authorizationCodeEncrypted: "encrypted-code",
            acceptedScopes: ["activity:read"],
            createdAt: 1_000,
            expiresAt: 2_000,
          });
          break;
        case "stravaWebhookEvents":
          await ctx.db.insert("stravaWebhookEvents", {
            eventKey: "event-1",
            subscriptionId: "subscription-1",
            objectType: "activity",
            aspectType: "create",
            objectId: "activity-1",
            ownerId: "athlete-1",
            eventTime: 1_000,
            userId: duplicateUserId,
            connectionGeneration: "generation-1",
            status: "received",
            attempts: 0,
            receivedAt: 1_000,
            updatedAt: 1_000,
          });
          break;
      }

      return duplicateUserId;
    });

    const result = await t.query(internal.migrations.repairOrphanedAuthAccounts.planEmail, {
      email,
    });

    expect(result).toMatchObject({
      kind: "plan",
      orphanIds: [orphanId],
      dataHits: [{ userId: orphanId, table }],
    });
  });
});
