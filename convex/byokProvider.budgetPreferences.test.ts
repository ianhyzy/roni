/// <reference types="vite/client" />
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encrypt } from "./tonal/encryption";
import {
  DEFAULT_PROVIDER_BUDGET_LIMITS_USD,
  MAX_PROVIDER_BUDGET_LIMIT_USD,
} from "../lib/aiBudgetPreferences";

const modules = import.meta.glob("./**/*.*s");

function createTest() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

async function createUserWithProfile(
  t: ReturnType<typeof convexTest>,
  selectedProvider = "gemini",
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("userProfiles", {
      userId,
      tonalUserId: `tonal-${userId}`,
      tonalToken: "encrypted",
      lastActiveAt: Date.now(),
      selectedProvider,
    });
    return userId;
  });
}

describe("AI provider budget preferences", () => {
  test("stores ignore budget without discarding the configured limit", async () => {
    const t = createTest();
    const userId = await createUserWithProfile(t, "openai");
    const authed = t.withIdentity({ subject: `${userId}|session` });

    await expect(
      authed.mutation(api.byokProvider.setSelectedProviderBudgetLimit, {
        budgetLimitUsd: 0.75,
      }),
    ).resolves.toMatchObject({
      ignoreBudget: false,
      providerLimitsUsd: { openai: 0.75 },
    });
    await expect(
      authed.mutation(api.byokProvider.setIgnoreBudget, { ignoreBudget: true }),
    ).resolves.toMatchObject({
      ignoreBudget: true,
      providerLimitsUsd: { openai: 0.75 },
    });

    const profile = await t.run(async (ctx) =>
      ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique(),
    );
    expect(profile?.ignoreAiProviderBudget).toBe(true);
    expect(profile?.aiProviderBudgetLimitsUsd?.openai).toBe(0.75);
  });

  test("keeps independent limits for each selected provider", async () => {
    const t = createTest();
    const userId = await createUserWithProfile(t, "claude");
    const authed = t.withIdentity({ subject: `${userId}|session` });

    await authed.mutation(api.byokProvider.setSelectedProviderBudgetLimit, {
      budgetLimitUsd: 0.4,
    });
    await t.run(async (ctx) => {
      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();
      if (!profile) throw new Error("User profile not found");
      await ctx.db.patch(profile._id, { selectedProvider: "gemini" });
    });

    const result = await authed.mutation(api.byokProvider.setSelectedProviderBudgetLimit, {
      budgetLimitUsd: 0.25,
    });

    expect(result.providerLimitsUsd).toMatchObject({ claude: 0.4, gemini: 0.25 });
  });

  test("rejects invalid limits", async () => {
    const t = createTest();
    const userId = await createUserWithProfile(t);
    const authed = t.withIdentity({ subject: `${userId}|session` });

    await expect(
      authed.mutation(api.byokProvider.setSelectedProviderBudgetLimit, { budgetLimitUsd: 0 }),
    ).rejects.toThrow("Budget threshold must be between $0.01 and $400.00");

    await expect(
      authed.mutation(api.byokProvider.setSelectedProviderBudgetLimit, {
        budgetLimitUsd: MAX_PROVIDER_BUDGET_LIMIT_USD + 1,
      }),
    ).rejects.toThrow("Budget threshold must be between $0.01 and $400.00");
  });

  test("rejects unauthenticated writes", async () => {
    const t = createTest();

    await expect(
      t.mutation(api.byokProvider.setIgnoreBudget, { ignoreBudget: true }),
    ).rejects.toThrow("Not authenticated");
  });

  test("rejects writes when the authenticated user has no profile", async () => {
    const t = createTest();
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const authed = t.withIdentity({ subject: `${userId}|session` });

    await expect(
      authed.mutation(api.byokProvider.setIgnoreBudget, { ignoreBudget: true }),
    ).rejects.toThrow("User profile not found");
  });

  test("projects legacy defaults and persisted preferences through provider settings", async () => {
    const t = createTest();
    const userId = await createUserWithProfile(t, "openai");
    const authed = t.withIdentity({ subject: `${userId}|session` });
    const originalEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    const encryptionKey = "66".repeat(32);
    process.env.TOKEN_ENCRYPTION_KEY = encryptionKey;
    try {
      const encryptedKey = await encrypt("sk-test-key-ending-6789", encryptionKey);
      await t.run(async (ctx) => {
        const profile = await ctx.db
          .query("userProfiles")
          .withIndex("by_userId", (q) => q.eq("userId", userId))
          .unique();
        if (!profile) throw new Error("User profile not found");
        await ctx.db.patch(profile._id, { openaiApiKeyEncrypted: encryptedKey });
      });

      await expect(authed.action(api.byokProvider.getProviderSettings, {})).resolves.toMatchObject({
        selectedProvider: "openai",
        budgetPreferences: {
          ignoreBudget: false,
          providerLimitsUsd: { openai: DEFAULT_PROVIDER_BUDGET_LIMITS_USD.openai },
        },
        keys: { openai: { hasKey: true, maskedLast4: "6789" } },
      });

      await authed.mutation(api.byokProvider.setSelectedProviderBudgetLimit, {
        budgetLimitUsd: 0.8,
      });
      await authed.mutation(api.byokProvider.setIgnoreBudget, { ignoreBudget: true });

      await expect(authed.action(api.byokProvider.getProviderSettings, {})).resolves.toMatchObject({
        budgetPreferences: {
          ignoreBudget: true,
          providerLimitsUsd: { openai: 0.8 },
        },
      });
    } finally {
      if (originalEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
    }
  });
});
