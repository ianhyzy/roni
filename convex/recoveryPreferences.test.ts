/// <reference types="vite/client" />
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

function createTest() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

async function createUserWithProfile(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("userProfiles", {
      userId,
      tonalUserId: `tonal-${userId}`,
      tonalToken: "encrypted",
      lastActiveAt: Date.now(),
    });
    return userId;
  });
}

describe("recoveryPreferences", () => {
  test("sets, reads, and clears the authenticated user's preferred source", async () => {
    const t = createTest();
    const userId = await createUserWithProfile(t);
    const authed = t.withIdentity({ subject: `${userId}|session` });

    await expect(authed.query(api.recoveryPreferences.getMine, {})).resolves.toEqual({
      preferredSource: null,
    });
    await expect(
      authed.mutation(api.recoveryPreferences.setMine, { preferredSource: "garmin" }),
    ).resolves.toEqual({ preferredSource: "garmin" });
    await expect(authed.query(api.recoveryPreferences.getMine, {})).resolves.toEqual({
      preferredSource: "garmin",
    });
    await expect(
      authed.mutation(api.recoveryPreferences.setMine, { preferredSource: null }),
    ).resolves.toEqual({ preferredSource: null });
    await expect(authed.query(api.recoveryPreferences.getMine, {})).resolves.toEqual({
      preferredSource: null,
    });
  });

  test("rejects unauthenticated preference writes", async () => {
    const t = createTest();

    await expect(
      t.mutation(api.recoveryPreferences.setMine, { preferredSource: "fitbit" }),
    ).rejects.toThrow("Not authenticated");
  });

  test("rejects preference writes when the authenticated user has no profile", async () => {
    const t = createTest();
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const authed = t.withIdentity({ subject: `${userId}|session` });

    await expect(
      authed.mutation(api.recoveryPreferences.setMine, { preferredSource: "garmin" }),
    ).rejects.toThrow("User profile not found");
  });

  test("does not expose another user's preferred source", async () => {
    const t = createTest();
    const firstUserId = await createUserWithProfile(t);
    const secondUserId = await createUserWithProfile(t);
    const first = t.withIdentity({ subject: `${firstUserId}|session` });
    const second = t.withIdentity({ subject: `${secondUserId}|session` });

    await first.mutation(api.recoveryPreferences.setMine, { preferredSource: "fitbit" });

    await expect(second.query(api.recoveryPreferences.getMine, {})).resolves.toEqual({
      preferredSource: null,
    });
  });
});
