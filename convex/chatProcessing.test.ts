/// <reference types="vite/client" />
import { saveMessage } from "@convex-dev/agent";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { classifyPromptIntent, selectCoachTierRoute } from "./chatProcessing";
import schema from "./schema";

const checkDailyBudgetMock = vi.hoisted(() => vi.fn());
const clearTurnRetryingMock = vi.hoisted(() => vi.fn(async () => undefined));
const assertThreadOwnershipMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolveUserProviderConfigMock = vi.hoisted(() => vi.fn());
const streamWithRetryMock = vi.hoisted(() => vi.fn());

vi.mock("@convex-dev/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/agent")>()),
  saveMessage: vi.fn(async () => ({ messageId: "prompt-1" })),
}));

vi.mock("./ai/budget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai/budget")>()),
  checkDailyBudget: checkDailyBudgetMock,
}));

vi.mock("./ai/resilience", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai/resilience")>()),
  streamWithRetry: streamWithRetryMock,
}));

vi.mock("./ai/resilienceReporting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai/resilienceReporting")>()),
  clearTurnRetrying: clearTurnRetryingMock,
}));

vi.mock("./chatHelpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chatHelpers")>()),
  assertThreadOwnership: assertThreadOwnershipMock,
  resolveUserProviderConfig: resolveUserProviderConfigMock,
}));

const modules = import.meta.glob("./**/*.*s");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processMessage", () => {
  it("persists and anchors the prompt before stopping an over-budget turn", async () => {
    checkDailyBudgetMock.mockResolvedValue(true);
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    await t.action(internal.chatProcessing.processMessage, {
      threadId: "thread-1",
      userId,
      prompt: "Hello",
    });

    expect(saveMessage).toHaveBeenCalledTimes(1);
    expect(saveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        threadId: "thread-1",
        userId,
        message: { role: "user", content: "Hello" },
      }),
    );
    expect(checkDailyBudgetMock).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      "thread-1",
      "prompt-1",
    );
    expect(vi.mocked(saveMessage).mock.invocationCallOrder[0]).toBeLessThan(
      checkDailyBudgetMock.mock.invocationCallOrder[0],
    );
    expect(streamWithRetryMock).not.toHaveBeenCalled();
  });

  it("anchors budget-check failures to the persisted prompt", async () => {
    checkDailyBudgetMock.mockRejectedValue(new Error("budget query failed"));
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    await t.action(internal.chatProcessing.processMessage, {
      threadId: "thread-1",
      userId,
      prompt: "Hello",
    });

    expect(saveMessage).toHaveBeenCalledTimes(2);
    expect(saveMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        threadId: "thread-1",
        promptMessageId: "prompt-1",
        userId,
        message: expect.objectContaining({ role: "assistant" }),
      }),
    );
    expect(streamWithRetryMock).not.toHaveBeenCalled();
    expect(clearTurnRetryingMock).toHaveBeenCalledWith(expect.anything(), {
      threadId: "thread-1",
      promptMessageId: "prompt-1",
    });
  });

  it("clears the retry lease even when terminal response persistence fails", async () => {
    checkDailyBudgetMock.mockRejectedValue(new Error("budget query failed"));
    const defaultSaveMessage = vi.mocked(saveMessage).getMockImplementation();
    if (!defaultSaveMessage) throw new Error("saveMessage mock is not configured");
    vi.mocked(saveMessage)
      .mockImplementationOnce(defaultSaveMessage)
      .mockRejectedValueOnce(new Error("message persistence failed"));
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    await expect(
      t.action(internal.chatProcessing.processMessage, {
        threadId: "thread-1",
        userId,
        prompt: "Hello",
      }),
    ).rejects.toThrow("message persistence failed");

    expect(clearTurnRetryingMock).toHaveBeenCalledWith(expect.anything(), {
      threadId: "thread-1",
      promptMessageId: "prompt-1",
    });
  });
});

describe("continueAfterApproval", () => {
  it("clears the anchored retry lease after a continuation failure", async () => {
    resolveUserProviderConfigMock.mockRejectedValueOnce(new Error("provider resolution failed"));
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    await t.action(internal.chatProcessing.continueAfterApproval, {
      threadId: "thread-1",
      messageId: "approval-message-1",
      userId,
    });

    expect(assertThreadOwnershipMock).toHaveBeenCalledWith(expect.anything(), "thread-1", userId);
    expect(clearTurnRetryingMock).toHaveBeenCalledWith(expect.anything(), {
      threadId: "thread-1",
      promptMessageId: "approval-message-1",
    });
    expect(saveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        threadId: "thread-1",
        promptMessageId: "approval-message-1",
        userId,
      }),
    );
  });
});

describe("classifyPromptIntent", () => {
  const chars = (length: number) => "x".repeat(length);

  it("routes short low-intent messages as trivial", () => {
    expect(classifyPromptIntent("hello")).toBe("trivial");
    expect(classifyPromptIntent("thanks!")).toBe("trivial");
  });

  it("uses a strict length boundary for trivial messages", () => {
    expect(classifyPromptIntent(chars(29))).toBe("trivial");
    expect(classifyPromptIntent(chars(30))).toBe("default");
  });

  it("keeps short programming and tool commands complex", () => {
    expect(classifyPromptIntent("push it")).toBe("complex");
    expect(classifyPromptIntent("swap bench press")).toBe("complex");
  });

  it("routes longer non-keyword messages as default", () => {
    expect(classifyPromptIntent("How should I think about my last workout?")).toBe("default");
  });
});

describe("selectCoachTierRoute", () => {
  const tierAgents = {
    router: { name: "router" },
    chat: { name: "chat" },
    programming: { name: "programming" },
    summarize: { name: "summarize" },
  };
  const tierModelNames = {
    router: "router-model",
    chat: "chat-model",
    programming: "programming-model",
    summarize: "summarize-model",
  };

  it("routes trivial prompts to the tool-capable chat tier, not the flash-lite router", () => {
    // Regression: trivial prompts used to start on the router (flash-lite) tier,
    // which would not reliably drive search_exercises -> create_workout, so short
    // workout requests like "make me a workout" silently produced no workout.
    const route = selectCoachTierRoute(
      {
        tierAgents,
        tierModelNames,
        fallbackModelName: "router-model",
      },
      "trivial",
    );

    expect(route.primary).toBe(tierAgents.chat);
    expect(route.primaryModelName).toBe("chat-model");
    expect(route.primaryTier).toBe("chat");
    expect(route.primaryTier).not.toBe("router");
  });

  it("uses the programming model first for complex prompts", () => {
    const route = selectCoachTierRoute(
      {
        tierAgents,
        tierModelNames,
        fallbackModelName: "router-model",
      },
      "complex",
    );

    expect(route.primary).toBe(tierAgents.programming);
    expect(route.fallback).toBe(tierAgents.chat);
    expect(route.primaryModelName).toBe("programming-model");
    expect(route.fallbackModelName).toBe("chat-model");
    expect(route.primaryTier).toBe("programming");
    expect(route.fallbackTier).toBe("chat");
  });

  it("uses the chat model first for default prompts", () => {
    const route = selectCoachTierRoute(
      {
        tierAgents,
        tierModelNames,
        fallbackModelName: "router-model",
      },
      "default",
    );

    expect(route.primary).toBe(tierAgents.chat);
    expect(route.fallback).toBe(tierAgents.router);
    expect(route.primaryModelName).toBe("chat-model");
    expect(route.fallbackModelName).toBe("router-model");
    expect(route.primaryTier).toBe("chat");
    expect(route.fallbackTier).toBe("router");
  });

  it("uses programming then chat for approval continuation", () => {
    const route = selectCoachTierRoute(
      {
        tierAgents,
        tierModelNames,
        fallbackModelName: "router-model",
      },
      "approval_continuation",
    );

    expect(route.primary).toBe(tierAgents.programming);
    expect(route.fallback).toBe(tierAgents.chat);
    expect(route.primaryModelName).toBe("programming-model");
    expect(route.fallbackModelName).toBe("chat-model");
    expect(route.primaryTier).toBe("programming");
    expect(route.fallbackTier).toBe("chat");
  });

  it("keeps the selected tier as fallback when the provider has no fallback model", () => {
    const route = selectCoachTierRoute(
      {
        tierAgents,
        tierModelNames: {
          router: "openrouter/auto",
          chat: "openrouter/auto",
          programming: "openrouter/auto",
          summarize: "openrouter/auto",
        },
        fallbackModelName: null,
      },
      "trivial",
    );

    expect(route.primary).toBe(tierAgents.chat);
    expect(route.fallback).toBe(tierAgents.chat);
    expect(route.primaryModelName).toBe("openrouter/auto");
    expect(route.fallbackModelName).toBeNull();
    expect(route.primaryTier).toBe("chat");
    expect(route.fallbackTier).toBe("chat");
  });
});
