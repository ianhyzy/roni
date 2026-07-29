import type { MessageDoc } from "@convex-dev/agent";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  extractMemoryFactsFromTurn,
  getEligiblePromptText,
  shouldScheduleMemoryExtraction,
} from "./memoryFactExtraction";

const generateTextMock = vi.hoisted(() => vi.fn());
const resolveUserProviderConfigMock = vi.hoisted(() => vi.fn());

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ai")>()),
  generateText: generateTextMock,
}));

vi.mock("../chatHelpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../chatHelpers")>()),
  resolveUserProviderConfig: resolveUserProviderConfigMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function userMessage(overrides: Partial<MessageDoc> = {}): MessageDoc {
  return {
    _id: "message-1",
    _creationTime: 1,
    userId: "user-1",
    threadId: "thread-1",
    order: 1,
    stepOrder: 0,
    status: "success",
    tool: false,
    message: { role: "user", content: "I prefer evening workouts." },
    text: "I prefer evening workouts.",
    ...overrides,
  };
}

describe("memory fact extraction eligibility", () => {
  it("recognizes explicit durable preference language", () => {
    expect(shouldScheduleMemoryExtraction("I hate Bulgarian split squats.")).toBe(true);
    expect(shouldScheduleMemoryExtraction("I usually train in the evening.")).toBe(true);
    expect(shouldScheduleMemoryExtraction("Can you explain progressive overload?")).toBe(false);
  });

  it("accepts only the successful owned user prompt anchor", () => {
    const expected = { userId: "user-1", threadId: "thread-1" };

    expect(getEligiblePromptText(userMessage(), expected)).toBe("I prefer evening workouts.");
    expect(getEligiblePromptText(userMessage({ userId: "user-2" }), expected)).toBeNull();
    expect(getEligiblePromptText(userMessage({ threadId: "thread-2" }), expected)).toBeNull();
    expect(getEligiblePromptText(userMessage({ status: "failed" }), expected)).toBeNull();
    expect(
      getEligiblePromptText(
        userMessage({
          message: { role: "assistant", content: "I prefer evening workouts." },
        }),
        expected,
      ),
    ).toBeNull();
  });

  it("rejects missing, non-string, and oversized prompt text", () => {
    const expected = { userId: "user-1", threadId: "thread-1" };

    expect(getEligiblePromptText(null, expected)).toBeNull();
    expect(getEligiblePromptText(userMessage({ text: undefined }), expected)).toBeNull();
    expect(getEligiblePromptText(userMessage({ text: "x".repeat(2_001) }), expected)).toBeNull();
  });
});

describe("extractMemoryFactsFromTurn", () => {
  it("records usage and persists structured facts from an owned prompt", async () => {
    const userId = "user-1" as Id<"users">;
    resolveUserProviderConfigMock.mockResolvedValue({
      provider: "gemini",
      apiKey: "test-key",
      isHouseKey: true,
    });
    generateTextMock.mockResolvedValue({
      output: {
        facts: [
          {
            category: "schedule_preference",
            subject: "workout time",
            fact: "The user prefers evening workouts.",
            confidence: 0.97,
          },
        ],
      },
      totalUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    });
    const runQuery = vi.fn(async () => [userMessage()]);
    const runMutation = vi.fn(
      async (reference: Parameters<typeof getFunctionName>[0], _args: unknown) => {
        const name = getFunctionName(reference);
        if (name === "aiUsage:record") return undefined;
        if (name === "userMemoryFacts:persistExtractedFacts") {
          return { ok: true, inserted: 1, updated: 0, rejected: 0 };
        }
        throw new Error(`Unexpected mutation: ${name}`);
      },
    );

    const result = await extractMemoryFactsFromTurn(
      { runQuery, runMutation } as unknown as ActionCtx,
      { userId, threadId: "thread-1", promptMessageId: "message-1" },
    );

    expect(result).toEqual({ status: "stored", inserted: 1, updated: 0, rejected: 0 });
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "I prefer evening workouts.",
        temperature: 0,
        maxRetries: 0,
      }),
    );
    expect(runMutation.mock.calls.map(([reference]) => getFunctionName(reference))).toEqual([
      "aiUsage:record",
      "userMemoryFacts:persistExtractedFacts",
    ]);
    expect(runMutation).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId,
        sourceMessageId: "message-1",
        facts: [expect.objectContaining({ subject: "workout time", confidence: 0.97 })],
      }),
    );
  });

  it("contains provider failures without persisting a fact", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      resolveUserProviderConfigMock.mockRejectedValue(new Error("provider unavailable"));
      const runMutation = vi.fn();

      const result = await extractMemoryFactsFromTurn(
        {
          runQuery: vi.fn(async () => [userMessage()]),
          runMutation,
        } as unknown as ActionCtx,
        {
          userId: "user-1" as Id<"users">,
          threadId: "thread-1",
          promptMessageId: "message-1",
        },
      );

      expect(result).toEqual({ status: "failed" });
      expect(generateTextMock).not.toHaveBeenCalled();
      expect(runMutation).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith("[memoryFactExtraction] extraction_failed");
    } finally {
      warnSpy.mockRestore();
    }
  });
});
