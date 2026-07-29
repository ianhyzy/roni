/// <reference types="vite/client" />
import { createThread, fetchContextWithPrompt, saveMessages } from "@convex-dev/agent";
import agentTest from "@convex-dev/agent/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { components } from "./_generated/api";
import { makeCoachAgentConfig } from "./ai/coach";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("agent search provenance contract", () => {
  it("attributes a real text-search result and strips provenance before provider output", async () => {
    const t = convexTest(schema, modules);
    agentTest.register(t);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const searchThreadId = await t.run((ctx) => createThread(ctx, components.agent, { userId }));
    await t.run((ctx) =>
      saveMessages(ctx, components.agent, {
        threadId: searchThreadId,
        userId,
        messages: [{ role: "user", content: "I prefer cat-cow mobility before lifting" }],
        metadata: [{ status: "success" }],
      }),
    );
    const currentThreadId = await t.run((ctx) => createThread(ctx, components.agent, { userId }));
    const timing = {};
    const config = makeCoachAgentConfig({ timing, retrievalEnabled: true });
    const actionCtx = {
      runQuery: t.query,
      runMutation: t.mutation,
      runAction: t.action,
    } as Parameters<typeof fetchContextWithPrompt>[0];

    const result = await fetchContextWithPrompt(actionCtx, components.agent, {
      userId,
      threadId: currentThreadId,
      prompt: "What mobility warmup did I prefer?",
      messages: undefined,
      promptMessageId: undefined,
      agentName: "search-provenance-test",
      contextOptions: {
        recentMessages: 0,
        searchOtherThreads: true,
        searchOptions: {
          textSearch: true,
          vectorSearch: false,
          limit: 2,
          messageRange: { before: 0, after: 0 },
        },
      },
      contextHandler: config.contextHandler,
      usageHandler: undefined,
      callSettings: {},
    });

    expect(timing).toMatchObject({ searchHits: 1, searchUsed: true });
    expect(result.messages.some((message) => JSON.stringify(message).includes("cat-cow"))).toBe(
      true,
    );
    expect(
      result.messages.every((message) => Object.getOwnPropertySymbols(message).length === 0),
    ).toBe(true);
  });
});
