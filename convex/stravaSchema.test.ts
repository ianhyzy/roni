/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("Strava schema", () => {
  test("accepts active and disconnected connection variants", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      await ctx.db.insert("stravaConnections", {
        userId,
        athleteId: "athlete-active",
        generation: "generation-active",
        status: "active",
        accessTokenEncrypted: "access-token-encrypted",
        refreshTokenEncrypted: "refresh-token-encrypted",
        tokenExpiresAt: 2_000,
        scopes: ["activity:read"],
        connectedAt: 1_000,
        refreshDueAt: 1_500,
        lastSyncAttemptAt: 1_100,
        lastSyncedAt: 1_200,
        lastSyncError: "temporary failure",
      });
      await ctx.db.insert("stravaConnections", {
        userId,
        athleteId: "athlete-disconnected",
        generation: "generation-disconnected",
        status: "disconnected",
        scopes: ["activity:read"],
        connectedAt: 1_000,
        disconnectedAt: 2_000,
        disconnectReason: "permission_revoked",
      });
    });

    const connections = await t.run(async (ctx) =>
      ctx.db.query("stravaConnections").order("asc").collect(),
    );
    expect(connections.map((connection) => connection.status)).toEqual(["active", "disconnected"]);
  });

  test("accepts only the sanitized Strava webhook update fields", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    await t.run(async (ctx) => {
      await ctx.db.insert("stravaWebhookEvents", {
        eventKey: "event-sanitized",
        subscriptionId: "subscription-1",
        objectType: "activity",
        aspectType: "update",
        objectId: "activity-1",
        ownerId: "athlete-1",
        eventTime: 1_000,
        updates: {
          title: "Morning run",
          type: "Run",
          private: "false",
          authorized: "true",
        },
        userId,
        connectionGeneration: "generation-1",
        status: "received",
        attempts: 0,
        receivedAt: 1_000,
        updatedAt: 1_000,
      });
    });

    const event = await t.run(async (ctx) =>
      ctx.db
        .query("stravaWebhookEvents")
        .withIndex("by_eventKey", (q) => q.eq("eventKey", "event-sanitized"))
        .unique(),
    );
    expect(event?.updates).toEqual({
      title: "Morning run",
      type: "Run",
      private: "false",
      authorized: "true",
    });

    const unsanitizedUpdates = { title: "Run", access_token: "raw-secret" };
    await expect(
      t.run(async (ctx) =>
        ctx.db.insert("stravaWebhookEvents", {
          eventKey: "event-unsanitized",
          subscriptionId: "subscription-1",
          objectType: "activity",
          aspectType: "update",
          objectId: "activity-2",
          ownerId: "athlete-1",
          eventTime: 1_100,
          updates: unsanitizedUpdates,
          userId,
          connectionGeneration: "generation-1",
          status: "received",
          attempts: 0,
          receivedAt: 1_100,
          updatedAt: 1_100,
        }),
      ),
    ).rejects.toThrow();
  });
});
