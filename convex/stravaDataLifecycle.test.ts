/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { JSON_EXPORT_SECTION_KEYS, USER_DATA_TABLES } from "./userData";

const modules = import.meta.glob("./**/*.*s");

const STRAVA_REGISTRY_ENTRIES = [
  { table: "stravaConnections", delete: "byUserIdBatch", jsonExportKey: null },
  { table: "stravaOauthStates", delete: "byUserIdBatch", jsonExportKey: null },
  { table: "stravaOauthCallbackTickets", delete: "byUserIdBatch", jsonExportKey: null },
  { table: "stravaWebhookEvents", delete: "byUserIdBatch", jsonExportKey: null },
] as const;

async function insertStravaData(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  suffix: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("stravaConnections", {
      userId,
      athleteId: `athlete-${suffix}`,
      generation: `generation-${suffix}`,
      status: "active",
      accessTokenEncrypted: `access-secret-${suffix}`,
      refreshTokenEncrypted: `refresh-secret-${suffix}`,
      tokenExpiresAt: 2_000,
      scopes: ["activity:read"],
      connectedAt: 1_000,
      refreshDueAt: 1_500,
    });
    await ctx.db.insert("stravaOauthStates", {
      userId,
      stateHash: `state-${suffix}`,
      createdAt: 1_000,
      expiresAt: 2_000,
    });
    await ctx.db.insert("stravaOauthCallbackTickets", {
      userId,
      ticketHash: `ticket-${suffix}`,
      authorizationCodeEncrypted: `code-secret-${suffix}`,
      acceptedScopes: ["activity:read"],
      createdAt: 1_000,
      expiresAt: 2_000,
    });
    await ctx.db.insert("stravaWebhookEvents", {
      eventKey: `event-${suffix}`,
      subscriptionId: "subscription-1",
      objectType: "activity",
      aspectType: "create",
      objectId: `activity-${suffix}`,
      ownerId: `athlete-${suffix}`,
      eventTime: 1_100,
      userId,
      connectionGeneration: `generation-${suffix}`,
      status: "received",
      attempts: 0,
      receivedAt: 1_100,
      updatedAt: 1_100,
    });
    await ctx.db.insert("externalActivities", {
      userId,
      externalId: `strava-activity-${suffix}`,
      workoutType: "Run",
      beginTime: "2026-07-30T12:00:00Z",
      totalDuration: 1_800,
      source: "strava",
      distance: 5_000,
      stravaConnectionGeneration: `generation-${suffix}`,
      syncedAt: 1_200,
    });
  });
}

describe("Strava user-data lifecycle", () => {
  test("registers every Strava artifact as owner-deleted and non-exported", () => {
    const entries = USER_DATA_TABLES.filter((entry) => entry.table.startsWith("strava"));

    expect(entries).toEqual(STRAVA_REGISTRY_ENTRIES);
    expect(JSON_EXPORT_SECTION_KEYS.filter((key) => key.toLowerCase().includes("strava"))).toEqual(
      [],
    );
  });

  test("deletes only the target user's Strava artifacts and external activities", async () => {
    const t = convexTest(schema, modules);
    const [userId, otherUserId] = await t.run(async (ctx) => [
      await ctx.db.insert("users", {}),
      await ctx.db.insert("users", {}),
    ]);
    await insertStravaData(t, userId, "target");
    await insertStravaData(t, otherUserId, "other");

    for (const { table } of STRAVA_REGISTRY_ENTRIES) {
      await t.mutation(internal.accountDeletion.deleteUserTableBatch, { userId, table });
    }
    await t.mutation(internal.accountDeletion.deleteExternalActivitiesBatch, { userId });

    const remainingOwners = await t.run(async (ctx) => ({
      connections: (await ctx.db.query("stravaConnections").collect()).map((row) => row.userId),
      states: (await ctx.db.query("stravaOauthStates").collect()).map((row) => row.userId),
      tickets: (await ctx.db.query("stravaOauthCallbackTickets").collect()).map(
        (row) => row.userId,
      ),
      events: (await ctx.db.query("stravaWebhookEvents").collect()).map((row) => row.userId),
      activities: (await ctx.db.query("externalActivities").collect()).map((row) => row.userId),
    }));

    expect(remainingOwners).toEqual({
      connections: [otherUserId],
      states: [otherUserId],
      tickets: [otherUserId],
      events: [otherUserId],
      activities: [otherUserId],
    });
  });

  test("exports Strava activities without exporting OAuth or webhook artifacts", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await insertStravaData(t, userId, "export");

    const data = await t.query(internal.dataExport.collectUserData, { userId });
    const serialized = JSON.stringify(data);

    expect(data.externalActivities).toHaveLength(1);
    expect(data.externalActivities[0]).toMatchObject({
      workoutType: "Run",
      source: "strava",
      distance: 5_000,
    });
    expect(data.externalActivities[0]).not.toHaveProperty("stravaConnectionGeneration");
    expect(data.externalActivities[0]).not.toHaveProperty("externalId");
    expect(data.externalActivities[0]).not.toHaveProperty("syncedAt");
    expect(serialized).not.toContain("access-secret-export");
    expect(serialized).not.toContain("refresh-secret-export");
    expect(serialized).not.toContain("code-secret-export");
    expect(serialized).not.toContain("generation-export");
    expect(serialized).not.toContain("event-export");
    expect(serialized).not.toContain("subscription-1");
    expect(data).not.toHaveProperty("stravaConnections");
    expect(data).not.toHaveProperty("stravaOauthStates");
    expect(data).not.toHaveProperty("stravaOauthCallbackTickets");
    expect(data).not.toHaveProperty("stravaWebhookEvents");
  });
});
