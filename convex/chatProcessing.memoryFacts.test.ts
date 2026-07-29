/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
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
  assertThreadOwnership: vi.fn(async () => undefined),
  resolveUserProviderConfig: resolveUserProviderConfigMock,
}));

const modules = import.meta.glob("./**/*.*s");

function successfulAccumulator() {
  return {
    setContextTiming: vi.fn(),
    toRow: vi.fn(() => ({})),
  };
}

async function createTestUser(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.insert("users", {}));
}

function configureSuccessfulTurn(): void {
  checkDailyBudgetMock.mockResolvedValue(false);
  resolveUserProviderConfigMock.mockResolvedValue({
    provider: "gemini",
    apiKey: "test-gemini-key",
    isHouseKey: true,
  });
  streamWithRetryMock.mockResolvedValue(successfulAccumulator());
}

async function getExtractionJobs(t: ReturnType<typeof convexTest>) {
  const scheduled = await t.run(async (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  return scheduled.filter((job) => job.name.includes("memoryFactExtraction:extractFromTurn"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processMessage memory fact scheduling", () => {
  it("schedules preference extraction once after a successful interesting turn", async () => {
    configureSuccessfulTurn();
    const t = convexTest(schema, modules);
    const userId = await createTestUser(t);

    await t.action(internal.chatProcessing.processMessage, {
      threadId: "thread-1",
      userId,
      prompt: "I hate Bulgarian split squats.",
    });
    const extractionJobs = await getExtractionJobs(t);

    expect(extractionJobs).toHaveLength(1);
    expect(extractionJobs[0]?.args).toEqual([
      { userId, threadId: "thread-1", promptMessageId: "prompt-1" },
    ]);
  });

  it("does not schedule extraction for an ordinary successful turn", async () => {
    configureSuccessfulTurn();
    const t = convexTest(schema, modules);
    const userId = await createTestUser(t);

    await t.action(internal.chatProcessing.processMessage, {
      threadId: "thread-1",
      userId,
      prompt: "Can you explain progressive overload?",
    });

    await expect(getExtractionJobs(t)).resolves.toEqual([]);
  });

  it("does not schedule extraction when the coach turn fails", async () => {
    checkDailyBudgetMock.mockResolvedValue(false);
    resolveUserProviderConfigMock.mockResolvedValue({
      provider: "gemini",
      apiKey: "test-gemini-key",
      isHouseKey: true,
    });
    streamWithRetryMock.mockRejectedValue(new Error("provider unavailable"));
    const t = convexTest(schema, modules);
    const userId = await createTestUser(t);

    await t.action(internal.chatProcessing.processMessage, {
      threadId: "thread-1",
      userId,
      prompt: "I prefer evening workouts.",
    });

    await expect(getExtractionJobs(t)).resolves.toEqual([]);
  });
});
