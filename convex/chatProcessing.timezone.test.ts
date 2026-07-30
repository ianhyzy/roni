/// <reference types="vite/client" />
import { saveMessage } from "@convex-dev/agent";
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import { DEFAULT_DAYS } from "./weekPlanHelpers";
import schema from "./schema";

const checkDailyBudgetMock = vi.hoisted(() => vi.fn());
const clearTurnRetryingMock = vi.hoisted(() => vi.fn(async () => undefined));
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
  resolveUserProviderConfig: resolveUserProviderConfigMock,
}));

const modules = import.meta.glob("./**/*.*s");

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("processMessage timezone week selection", () => {
  it("keeps weekly tools for a terse follow-up while Los Angeles is still Sunday", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T00:30:00.000Z"));
    checkDailyBudgetMock.mockResolvedValue(false);
    resolveUserProviderConfigMock.mockResolvedValue({
      provider: "gemini",
      apiKey: "test-gemini-key",
      isHouseKey: true,
    });
    streamWithRetryMock.mockResolvedValue({
      setContextTiming: vi.fn(),
      toRow: vi.fn(() => ({})),
    });
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    await t.run(async (ctx) => {
      const workoutPlanId = await ctx.db.insert("workoutPlans", {
        userId,
        title: "Los Angeles current-week draft",
        blocks: [],
        status: "draft",
        createdAt: 1,
      });
      const days = DEFAULT_DAYS.map((day, dayIndex) =>
        dayIndex === 0 ? { ...day, sessionType: "full_body" as const, workoutPlanId } : { ...day },
      );
      await ctx.db.insert("weekPlans", {
        userId,
        weekStartDate: "2026-03-02",
        preferredSplit: "full_body",
        targetDays: 1,
        days,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    await t.action(internal.chatProcessing.processMessage, {
      threadId: "thread-1",
      userId,
      prompt: "push it",
      userTimezone: "America/Los_Angeles",
    });

    const options = streamWithRetryMock.mock.calls[0]?.[1] as {
      prepareStep: (args: { steps: [] }) => { activeTools?: string[] };
      fallbackPrepareStep: (args: { steps: [] }) => { activeTools?: string[] };
    };
    const primaryTools = options.prepareStep({ steps: [] }).activeTools;
    const fallbackTools = options.fallbackPrepareStep({ steps: [] }).activeTools;
    expect(primaryTools).toEqual(expect.arrayContaining(["program_week", "delete_week_plan"]));
    expect(fallbackTools).toEqual(expect.arrayContaining(["program_week", "delete_week_plan"]));
    expect(primaryTools).not.toContain("create_workout");
    expect(fallbackTools).not.toContain("create_workout");
    expect(saveMessage).toHaveBeenCalledTimes(1);
  });
});
