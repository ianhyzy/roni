/// <reference types="vite/client" />
import { createThread, fetchContextWithPrompt, saveMessages } from "@convex-dev/agent";
import agentTest from "@convex-dev/agent/test";
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { components } from "./_generated/api";
import { buildCoachAgentsForProvider, makeCoachAgentConfig } from "./ai/coach";
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
    const config = makeCoachAgentConfig({ timing, messageSearchMode: "cross_thread" });
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

  it("builds continuation context from a textless approval response when message search is disabled", async () => {
    const t = convexTest(schema, modules);
    agentTest.register(t);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const threadId = await t.run((ctx) => createThread(ctx, components.agent, { userId }));
    const { messages: promptMessages } = await t.run((ctx) =>
      saveMessages(ctx, components.agent, {
        threadId,
        userId,
        messages: [{ role: "user", content: "Push the workouts" }],
        metadata: [{ status: "success" }],
      }),
    );
    await t.run((ctx) =>
      saveMessages(ctx, components.agent, {
        threadId,
        userId,
        promptMessageId: promptMessages[0]._id,
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "approve-week-1",
                toolName: "approve_week_plan",
                input: { weekPlanId: "week-plan-1" },
              },
              {
                type: "tool-approval-request",
                approvalId: "approval-1",
                toolCallId: "approve-week-1",
              },
            ],
          },
        ],
        metadata: [{ status: "success" }],
      }),
    );
    const { tierAgents } = buildCoachAgentsForProvider({
      provider: "gemini",
      apiKey: "test-key",
      messageSearchMode: "disabled",
    });
    const { messageId: approvalMessageId } = await t.run((ctx) =>
      tierAgents.programming.approveToolCall(ctx, {
        threadId,
        approvalId: "approval-1",
      }),
    );
    const approvalMessage = await t.run(async (ctx) => {
      const messages = await tierAgents.programming.listMessages(ctx, {
        threadId,
        paginationOpts: { cursor: null, numItems: 10 },
      });
      return messages.page.find((message) => message._id === approvalMessageId);
    });
    if (!approvalMessage) throw new Error("approval response message was not saved");
    expect(approvalMessage.text).toBeUndefined();
    const config = makeCoachAgentConfig({
      messageSearchMode: "disabled",
    });
    expect(config.contextOptions.searchOtherThreads).toBe(false);
    expect(config.contextOptions.searchOptions).toBeUndefined();
    const actionCtx = {
      runQuery: t.query,
      runMutation: t.mutation,
      runAction: t.action,
    } as Parameters<typeof fetchContextWithPrompt>[0];

    const result = await fetchContextWithPrompt(actionCtx, components.agent, {
      userId,
      threadId,
      prompt: undefined,
      messages: undefined,
      promptMessageId: approvalMessageId,
      agentName: "approval-continuation-test",
      contextOptions: config.contextOptions,
      contextHandler: config.contextHandler,
      usageHandler: undefined,
      callSettings: {},
    });

    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
  });
});
