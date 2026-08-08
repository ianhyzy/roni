/// <reference types="vite/client" />
import { saveMessage } from "@convex-dev/agent";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { classifyPromptIntent, selectCoachTierRoute } from "./chatProcessing";
import schema from "./schema";
import { DEFAULT_DAYS, getWeekStartDateString } from "./weekPlanHelpers";
import type { AiBudgetPolicy } from "../lib/aiBudgetPreferences";

const checkDailyBudgetMock = vi.hoisted(() => vi.fn());
const clearTurnRetryingMock = vi.hoisted(() => vi.fn(async () => undefined));
const assertThreadOwnershipMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolveUserProviderConfigMock = vi.hoisted(() => vi.fn());
const streamWithRetryMock = vi.hoisted(() => vi.fn());
const successfulAccumulator = () => ({
  setContextTiming: vi.fn(),
  toRow: vi.fn(() => ({})),
});

function resolveHouseProviderWithBudget(budgetPolicy: AiBudgetPolicy = { kind: "disabled" }): void {
  resolveUserProviderConfigMock.mockResolvedValue({
    provider: "gemini",
    apiKey: "test-gemini-key",
    isHouseKey: true,
    budgetPolicy,
  });
}

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

async function seedCurrentWeekPlan(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  workoutStatus: "draft" | "completed",
): Promise<void> {
  await t.run(async (ctx) => {
    const workoutPlanId = await ctx.db.insert("workoutPlans", {
      userId,
      title: "Current week workout",
      blocks: [],
      status: workoutStatus,
      createdAt: 1,
    });
    const days = DEFAULT_DAYS.map((day, dayIndex) =>
      dayIndex === 0 ? { ...day, sessionType: "full_body" as const, workoutPlanId } : { ...day },
    );
    await ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: getWeekStartDateString(new Date()),
      preferredSplit: "full_body",
      targetDays: 1,
      days,
      createdAt: 1,
      updatedAt: 1,
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processMessage", () => {
  it("configures weekly tool restrictions and initialized search telemetry", async () => {
    checkDailyBudgetMock.mockResolvedValue(false);
    resolveHouseProviderWithBudget();
    const accumulator = successfulAccumulator();
    streamWithRetryMock.mockResolvedValue(accumulator);
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    await t.action(internal.chatProcessing.processMessage, {
      threadId: "thread-1",
      userId,
      prompt: "Push Bens workout week 1 Monday",
    });
    const options = streamWithRetryMock.mock.calls[0]?.[1] as {
      primaryAgent: { options: { name: string } };
      fallbackAgent: { options: { name: string } };
      prepareStep: (args: { steps: [] }) => { activeTools?: string[] };
      fallbackPrepareStep: (args: { steps: [] }) => { activeTools?: string[] };
    };
    const primaryActiveTools = options.prepareStep({ steps: [] }).activeTools;
    const fallbackActiveTools = options.fallbackPrepareStep({ steps: [] }).activeTools;

    expect(options.primaryAgent.options.name).toBe("Roni (programming)");
    expect(options.fallbackAgent.options.name).toBe("Roni");
    expect(primaryActiveTools).toEqual(
      expect.arrayContaining(["program_week", "delete_week_plan", "rebuild_day", "check_deload"]),
    );
    expect(fallbackActiveTools).toEqual(
      expect.arrayContaining(["program_week", "delete_week_plan", "rebuild_day", "check_deload"]),
    );
    expect(primaryActiveTools).not.toContain("create_workout");
    expect(primaryActiveTools).not.toContain("delete_workout");
    expect(fallbackActiveTools).not.toContain("create_workout");
    expect(fallbackActiveTools).not.toContain("delete_workout");
    expect(options).toMatchObject({ budgetPolicy: { kind: "disabled" } });
    expect(accumulator.setContextTiming).toHaveBeenCalledWith({ searchHits: 0, searchUsed: false });
  });

  it("keeps a bare one-off push on the chat tier with all tools available", async () => {
    checkDailyBudgetMock.mockResolvedValue(false);
    resolveHouseProviderWithBudget();
    streamWithRetryMock.mockResolvedValue(successfulAccumulator());
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await seedCurrentWeekPlan(t, userId, "completed");

    await t.action(internal.chatProcessing.processMessage, {
      threadId: "thread-1",
      userId,
      prompt: "push it",
    });

    const options = streamWithRetryMock.mock.calls[0]?.[1] as {
      primaryAgent: { options: { name: string } };
      fallbackAgent: { options: { name: string } };
      prepareStep: (args: { steps: [] }) => { activeTools?: string[] };
      fallbackPrepareStep: (args: { steps: [] }) => { activeTools?: string[] };
    };
    expect(options.primaryAgent.options.name).toBe("Roni");
    expect(options.fallbackAgent.options.name).toBe("Roni (router)");
    expect(options.prepareStep({ steps: [] }).activeTools).toBeUndefined();
    expect(options.fallbackPrepareStep({ steps: [] }).activeTools).toBeUndefined();
  });

  it("restricts a terse follow-up when the current week has a pending draft", async () => {
    checkDailyBudgetMock.mockResolvedValue(false);
    resolveHouseProviderWithBudget();
    streamWithRetryMock.mockResolvedValue(successfulAccumulator());
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await seedCurrentWeekPlan(t, userId, "draft");

    await t.action(internal.chatProcessing.processMessage, {
      threadId: "thread-1",
      userId,
      prompt: "push it",
    });

    const options = streamWithRetryMock.mock.calls[0]?.[1] as {
      prepareStep: (args: { steps: [] }) => { activeTools?: string[] };
      fallbackPrepareStep: (args: { steps: [] }) => { activeTools?: string[] };
    };
    expect(options.prepareStep({ steps: [] }).activeTools).not.toContain("create_workout");
    expect(options.fallbackPrepareStep({ steps: [] }).activeTools).not.toContain("create_workout");
  });

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
  it("preserves weekly tool restrictions and initialized search telemetry after approval", async () => {
    resolveHouseProviderWithBudget({ kind: "limit", maxAttemptUsd: 0.42 });
    const accumulator = successfulAccumulator();
    streamWithRetryMock.mockResolvedValue(accumulator);
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.action(internal.chatProcessing.continueAfterApproval, {
      threadId: "thread-1",
      messageId: "approval-message-1",
      userId,
      toolMode: "weekly_programming",
    });
    const options = streamWithRetryMock.mock.calls[0]?.[1] as {
      primaryAgent: { options: { contextOptions: { searchOptions?: unknown } } };
      prepareStep: (args: { steps: [] }) => { activeTools?: string[] };
      fallbackPrepareStep: (args: { steps: [] }) => { activeTools?: string[] };
      promptMessageId: string;
      retrievalEnabled: boolean;
    };
    expect(options.prepareStep({ steps: [] }).activeTools).not.toContain("create_workout");
    expect(options.fallbackPrepareStep({ steps: [] }).activeTools).not.toContain("create_workout");
    expect(options.primaryAgent.options.contextOptions.searchOptions).toBeUndefined();
    expect(options.promptMessageId).toBe("approval-message-1");
    expect(options.retrievalEnabled).toBe(false);
    expect(options).toMatchObject({ budgetPolicy: { kind: "limit", maxAttemptUsd: 0.42 } });
    expect(accumulator.setContextTiming).toHaveBeenCalledWith({});
  });

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

  it.each([
    ["hello", "trivial"],
    ["thanks!", "trivial"],
    [chars(29), "trivial"],
    [chars(30), "default"],
    ["push it", "trivial"],
    ["swap bench press", "complex"],
    ["Push Bens workout week 1 Monday", "complex"],
    ["How should I think about my last workout?", "default"],
  ] as const)("classifies %s as %s", (prompt, expected) => {
    expect(classifyPromptIntent(prompt)).toBe(expected);
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

  it.each([
    ["trivial", "chat", "router"],
    ["complex", "programming", "chat"],
    ["default", "chat", "router"],
    ["approval_continuation", "programming", "chat"],
  ] as const)("routes %s turns through %s then %s", (intent, primaryTier, fallbackTier) => {
    const route = selectCoachTierRoute(
      { tierAgents, tierModelNames, fallbackModelName: "router-model" },
      intent,
    );

    expect(route.primary).toBe(tierAgents[primaryTier]);
    expect(route.fallback).toBe(tierAgents[fallbackTier]);
    expect(route.primaryModelName).toBe(tierModelNames[primaryTier]);
    expect(route.fallbackModelName).toBe(tierModelNames[fallbackTier]);
    expect(route.primaryTier).toBe(primaryTier);
    expect(route.fallbackTier).toBe(fallbackTier);
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
