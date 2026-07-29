import { saveMessage } from "@convex-dev/agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { components } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { calculateWeightedUsageTokens } from "../aiUsage";
import { BUDGET_WARNING_THRESHOLD, DAILY_TOKEN_BUDGET } from "../aiUsage";
import { checkDailyBudget, shouldNotifyBudgetWarning } from "./budget";

vi.mock("@convex-dev/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/agent")>()),
  saveMessage: vi.fn(async () => ({ messageId: "assistant-1" })),
}));

const WARNING_THRESHOLD_TOKENS = DAILY_TOKEN_BUDGET * BUDGET_WARNING_THRESHOLD;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("checkDailyBudget", () => {
  it("anchors a budget-exceeded response to the submitted prompt", async () => {
    const runQuery = vi.fn(async () => ({
      totalTokens: DAILY_TOKEN_BUDGET,
      latestUsageTokens: DAILY_TOKEN_BUDGET,
    }));

    const exceeded = await checkDailyBudget(
      { runQuery } as unknown as ActionCtx,
      "user-1",
      "thread-1",
      "prompt-1",
    );

    expect(exceeded).toBe(true);
    expect(saveMessage).toHaveBeenCalledWith(
      expect.anything(),
      components.agent,
      expect.objectContaining({
        threadId: "thread-1",
        promptMessageId: "prompt-1",
        userId: "user-1",
        message: expect.objectContaining({ role: "assistant" }),
      }),
    );
  });
});

describe("shouldNotifyBudgetWarning", () => {
  it("notifies only when the latest usage record crossed the warning threshold", () => {
    expect(shouldNotifyBudgetWarning(WARNING_THRESHOLD_TOKENS - 1, 1000)).toBe(false);
    expect(shouldNotifyBudgetWarning(WARNING_THRESHOLD_TOKENS + 1, 1000)).toBe(true);
  });

  it("does not notify when the user was already above the threshold before the latest usage", () => {
    expect(shouldNotifyBudgetWarning(WARNING_THRESHOLD_TOKENS + 1000, 100)).toBe(false);
  });

  it("reaches the warning threshold later for cache-read-heavy Claude usage than fresh usage", () => {
    const freshUsage = calculateWeightedUsageTokens({
      provider: "claude",
      inputTokens: WARNING_THRESHOLD_TOKENS + 1,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const cachedUsage = calculateWeightedUsageTokens({
      provider: "claude",
      inputTokens: WARNING_THRESHOLD_TOKENS + 1,
      outputTokens: 0,
      cacheReadTokens: WARNING_THRESHOLD_TOKENS + 1,
      cacheWriteTokens: 0,
    });

    expect(shouldNotifyBudgetWarning(freshUsage, freshUsage)).toBe(true);
    expect(cachedUsage).toBeLessThan(WARNING_THRESHOLD_TOKENS);
    expect(shouldNotifyBudgetWarning(cachedUsage, cachedUsage)).toBe(false);
  });
});
