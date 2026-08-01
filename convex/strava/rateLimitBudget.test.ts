/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../schema";
import {
  markStravaRateLimitBudgetUnknown,
  markStravaRateLimitTransportFailure,
  type ObservedStravaRateLimitBudget,
  parseStravaRateLimitHeaders,
  recordStravaRateLimitBudget,
  reserveStravaRateLimitBudget,
} from "./rateLimitBudget";

const modules = import.meta.glob("../**/*.*s");
const NOW = Date.parse("2026-07-30T12:01:00Z");

function observed(
  overrides: Partial<ObservedStravaRateLimitBudget> = {},
): ObservedStravaRateLimitBudget {
  return {
    overallShortLimit: 200,
    overallDailyLimit: 2_000,
    overallShortUsage: 1,
    overallDailyUsage: 10,
    readShortLimit: 100,
    readDailyLimit: 1_000,
    readShortUsage: 1,
    readDailyUsage: 10,
    ...overrides,
  };
}

describe("Strava rate limit headers", () => {
  it("parses the overall and read limit pairs", () => {
    const headers = new Headers({
      "X-RateLimit-Limit": "200, 2000",
      "X-RateLimit-Usage": "12,345",
      "X-ReadRateLimit-Limit": "100,1000",
      "X-ReadRateLimit-Usage": "10,300",
    });

    expect(parseStravaRateLimitHeaders(headers)).toEqual({
      overallShortLimit: 200,
      overallDailyLimit: 2_000,
      overallShortUsage: 12,
      overallDailyUsage: 345,
      readShortLimit: 100,
      readDailyLimit: 1_000,
      readShortUsage: 10,
      readDailyUsage: 300,
    });
  });

  it.each([
    ["missing header", { "X-RateLimit-Limit": "200,2000" }],
    [
      "malformed pair",
      {
        "X-RateLimit-Limit": "200/2000",
        "X-RateLimit-Usage": "1,1",
        "X-ReadRateLimit-Limit": "100,1000",
        "X-ReadRateLimit-Usage": "1,1",
      },
    ],
    [
      "zero limit",
      {
        "X-RateLimit-Limit": "0,2000",
        "X-RateLimit-Usage": "1,1",
        "X-ReadRateLimit-Limit": "100,1000",
        "X-ReadRateLimit-Usage": "1,1",
      },
    ],
  ])("fails closed for a %s", (_label, values) => {
    expect(parseStravaRateLimitHeaders(new Headers(values))).toBeNull();
  });
});

describe("app-global Strava rate limit budget", () => {
  it("allows one bootstrap reservation and blocks concurrency until headers arrive", async () => {
    const t = convexTest(schema, modules);

    await expect(t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW))).resolves.toEqual({
      allowed: true,
    });
    await expect(t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW + 1))).resolves.toEqual({
      allowed: false,
      retryAfterMs: 29_999,
      reason: "awaiting_headers",
    });
    await expect(
      t.run((ctx) => ctx.db.query("stravaRateLimitBudget").collect()),
    ).resolves.toHaveLength(1);
  });

  it("never lets larger provider limits weaken configured caps", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW));

    await t.run((ctx) =>
      recordStravaRateLimitBudget(
        ctx,
        observed({
          overallShortLimit: 600,
          overallDailyLimit: 30_000,
          readShortLimit: 300,
          readDailyLimit: 15_000,
        }),
        NOW + 100,
      ),
    );

    const row = await t.run((ctx) => ctx.db.query("stravaRateLimitBudget").unique());
    expect(row).toMatchObject({ shortLimit: 100, dailyLimit: 1_000 });
  });

  it("recovers caps from latest headers while preserving usage high-water marks", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW));
    await t.run((ctx) =>
      recordStravaRateLimitBudget(
        ctx,
        observed({
          overallShortLimit: 80,
          overallDailyLimit: 800,
          readShortLimit: 50,
          readDailyLimit: 500,
          overallShortUsage: 3,
          readShortUsage: 2,
          overallDailyUsage: 25,
          readDailyUsage: 20,
        }),
        NOW + 100,
      ),
    );
    await t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW + 200));
    await t.run((ctx) =>
      recordStravaRateLimitBudget(
        ctx,
        observed({
          overallShortUsage: 2,
          readShortUsage: 2,
          overallDailyUsage: 20,
          readDailyUsage: 20,
        }),
        NOW + 300,
      ),
    );

    const row = await t.run((ctx) => ctx.db.query("stravaRateLimitBudget").unique());
    expect(row).toMatchObject({
      shortLimit: 100,
      dailyLimit: 1_000,
      shortReserved: 4,
      dailyReserved: 26,
      shortObservedUsage: 3,
      dailyObservedUsage: 25,
    });
  });

  it("blocks at either effective limit and resets the short-window count", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW));
    await t.run((ctx) =>
      recordStravaRateLimitBudget(
        ctx,
        observed({
          overallShortLimit: 2,
          readShortLimit: 2,
          overallShortUsage: 1,
          readShortUsage: 1,
        }),
        NOW + 100,
      ),
    );

    await expect(t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW + 200))).resolves.toEqual({
      allowed: true,
    });
    const denied = await t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW + 300));
    expect(denied).toMatchObject({ allowed: false, reason: "exhausted" });

    await expect(
      t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW + 15 * 60 * 1000)),
    ).resolves.toEqual({ allowed: true });
  });

  it("fails closed on unknown headers until the next UTC day", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW));
    await t.run((ctx) => markStravaRateLimitBudgetUnknown(ctx, NOW + 100));

    const denied = await t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW + 200));
    expect(denied).toMatchObject({ allowed: false, reason: "unknown" });

    const nextUtcDay = Date.parse("2026-07-31T00:00:00Z");
    await expect(t.run((ctx) => reserveStravaRateLimitBudget(ctx, nextUtcDay))).resolves.toEqual({
      allowed: true,
    });
    const row = await t.run((ctx) => ctx.db.query("stravaRateLimitBudget").unique());
    expect(row).toMatchObject({ shortReserved: 1, dailyReserved: 1 });
  });

  it("uses a short global backoff after a transport failure", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW));
    await t.run((ctx) => markStravaRateLimitTransportFailure(ctx, NOW + 100));

    await expect(t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW + 200))).resolves.toEqual({
      allowed: false,
      retryAfterMs: 29_900,
      reason: "awaiting_headers",
    });
    await expect(t.run((ctx) => reserveStravaRateLimitBudget(ctx, NOW + 30_100))).resolves.toEqual({
      allowed: true,
    });

    const row = await t.run((ctx) => ctx.db.query("stravaRateLimitBudget").unique());
    expect(row).not.toHaveProperty("awaitingHeadersUntil");
    expect(row).not.toHaveProperty("blockedUntil");
  });

  it("rejects invalid direct observations", async () => {
    const t = convexTest(schema, modules);

    await expect(
      t.run((ctx) => recordStravaRateLimitBudget(ctx, observed({ readDailyUsage: -1 }), NOW)),
    ).rejects.toThrow("Invalid Strava rate limit observation");
  });
});
