/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

async function createUser(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await t.run(async (ctx) => ctx.db.insert("users", {}));
}

function preference(fact: string) {
  return [
    {
      category: "schedule_preference" as const,
      subject: "workout time",
      fact,
      confidence: 0.95,
    },
  ];
}

describe("userMemoryFacts source ordering", () => {
  test("keeps the newer preference when an older extraction finishes last", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);

    await t.mutation(internal.userMemoryFacts.persistExtractedFacts, {
      userId,
      sourceMessageId: "message-newer",
      sourceMessageCreatedAt: 20,
      facts: preference("The user prefers morning workouts."),
    });
    const staleResult = await t.mutation(internal.userMemoryFacts.persistExtractedFacts, {
      userId,
      sourceMessageId: "message-older",
      sourceMessageCreatedAt: 10,
      facts: preference("The user prefers evening workouts."),
    });
    const stored = await t.run(async (ctx) => ctx.db.query("userMemoryFacts").unique());

    expect(staleResult).toEqual({ ok: true, inserted: 0, updated: 0, rejected: 1 });
    expect(stored).toMatchObject({
      fact: "The user prefers morning workouts.",
      sourceMessageId: "message-newer",
      sourceMessageCreatedAt: 20,
    });
  });

  test("uses message ID as the deterministic equal-timestamp tie breaker", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);

    await t.mutation(internal.userMemoryFacts.persistExtractedFacts, {
      userId,
      sourceMessageId: "message-b",
      sourceMessageCreatedAt: 20,
      facts: preference("The user prefers morning workouts."),
    });
    await t.mutation(internal.userMemoryFacts.persistExtractedFacts, {
      userId,
      sourceMessageId: "message-a",
      sourceMessageCreatedAt: 20,
      facts: preference("The user prefers evening workouts."),
    });
    const stored = await t.run(async (ctx) => ctx.db.query("userMemoryFacts").unique());

    expect(stored).toMatchObject({
      fact: "The user prefers morning workouts.",
      sourceMessageId: "message-b",
    });
  });

  test("upgrades legacy rows and rejects invalid source timestamps", async () => {
    const t = convexTest(schema, modules);
    const userId = await createUser(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("userMemoryFacts", {
        userId,
        fact: "The user prefers evening workouts.",
        category: "schedule_preference",
        dedupeKey: "workout-time",
        sourceMessageId: "legacy-message",
        createdAt: 1,
        lastReferencedAt: 1,
        confidence: 0.9,
      });
    });

    const upgraded = await t.mutation(internal.userMemoryFacts.persistExtractedFacts, {
      userId,
      sourceMessageId: "message-current",
      sourceMessageCreatedAt: 30,
      facts: preference("The user prefers morning workouts."),
    });
    const invalid = await t.mutation(internal.userMemoryFacts.persistExtractedFacts, {
      userId,
      sourceMessageId: "message-invalid",
      sourceMessageCreatedAt: -1,
      facts: preference("The user prefers evening workouts."),
    });

    expect(upgraded).toEqual({ ok: true, inserted: 0, updated: 1, rejected: 0 });
    expect(invalid).toEqual({
      ok: false,
      inserted: 0,
      updated: 0,
      rejected: 1,
      error: "invalid_source",
    });
  });
});
