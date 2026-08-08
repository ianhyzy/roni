import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import { makeCoachAgentConfig } from "./coach";
import {
  createApproveWeekPlanTool,
  createGetWeekPlanDetailsTool,
  deleteWeekPlanTool,
} from "./weekTools";

const MOCK_USAGE = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: {
    total: 1,
    text: 0,
    reasoning: 0,
  },
};

const WRITE_TOOL_CASES = [
  {
    name: "approve_week_plan",
    tool: createApproveWeekPlanTool(),
    input: {},
  },
  {
    name: "delete_week_plan",
    tool: deleteWeekPlanTool,
    input: {},
  },
];

describe("write tool approval policy", () => {
  test.each(WRITE_TOOL_CASES)(
    "$name pauses before its execute handler runs",
    async ({ name, tool, input }) => {
      const executeBoundary = vi.fn(async () => {
        throw new Error("Write tool execute handler ran before approval");
      });
      const toolWithContext = {
        ...tool,
        ctx: {
          userId: "test-user",
          runQuery: executeBoundary,
          runMutation: executeBoundary,
          runAction: executeBoundary,
        },
      };
      const modelResult = {
        content: [
          {
            type: "tool-call",
            toolCallId: `call-${name}`,
            toolName: name,
            input: JSON.stringify(input),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        usage: MOCK_USAGE,
        warnings: [],
      } satisfies LanguageModelV3GenerateResult;
      const model = new MockLanguageModelV3({
        doGenerate: modelResult,
      });

      const result = await generateText({
        model,
        tools: { [name]: toolWithContext },
        prompt: "Perform the requested write action.",
      });

      expect(executeBoundary.mock.calls.length).toBe(0);
      expect(
        result.content.some(
          (part) => part.type === "tool-approval-request" && part.toolCall.toolName === name,
        ),
      ).toBe(true);
    },
  );
});

describe("approveWeekPlanTool", () => {
  test("passes the sanitized user timezone to the week-plan push action", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T01:00:00.000Z"));
    try {
      const runAction = vi.fn(async (_ref: unknown, _args: unknown) => ({
        success: true,
        pushed: 0,
        failed: 0,
        schedulingFailed: 0,
        deferred: 0,
        skipped: 7,
        results: [],
      }));
      const runQuery = vi.fn(async (_ref: unknown, _args: unknown) => ({
        _id: "week-plan-1",
      }));
      const approveTool = makeCoachAgentConfig({
        userTimezone: " America/Los_Angeles ",
      }).tools.approve_week_plan;
      const tool = {
        ...approveTool,
        ctx: {
          userId: "test-user",
          runQuery,
          runMutation: vi.fn(async () => null),
          runAction,
        },
      };

      await tool.execute!({}, { toolCallId: "call-approve", messages: [] });

      expect(runQuery.mock.calls[0][1]).toEqual({
        userId: "test-user",
        weekStartDate: "2026-07-27",
      });
      expect(runAction.mock.calls[0][1]).toEqual({
        userId: "test-user",
        weekPlanId: "week-plan-1",
        userTimezone: "America/Los_Angeles",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports push divergence when workout creation succeeds but scheduling fails", async () => {
    const runAction = vi.fn(async (_ref: unknown) => ({
      success: false,
      pushed: 1,
      failed: 0,
      schedulingFailed: 1,
      deferred: 0,
      skipped: 6,
      results: [
        {
          dayIndex: 0,
          dayName: "Monday",
          sessionType: "push",
          status: "pushed" as const,
          tonalWorkoutId: "tonal-workout-1",
          scheduleStatus: "failed" as const,
          error: "Calendar unavailable",
          pushDivergence: {
            missingMovements: ["Bench Press"],
            extraMovements: [],
            setCountMismatches: [],
          },
        },
      ],
    }));
    const tool = {
      ...createApproveWeekPlanTool(),
      ctx: {
        userId: "test-user",
        runQuery: vi.fn(async () => ({ _id: "week-plan-1" })),
        runMutation: vi.fn(async () => null),
        runAction,
      },
    };

    const result = await tool.execute!({}, { toolCallId: "call-approve", messages: [] });

    expect(result).toMatchObject({
      divergenceNote: expect.stringContaining("Monday"),
    });
    expect(getFunctionName(runAction.mock.calls[0][0] as never)).toBe(
      "coach/pushAndVerify:pushWeekPlanToTonal",
    );
  });

  test("returns deferred days as retryable incomplete work", async () => {
    const runAction = vi.fn(async () => ({
      success: false,
      pushed: 0,
      failed: 0,
      schedulingFailed: 0,
      deferred: 1,
      skipped: 6,
      results: [
        {
          dayIndex: 0,
          dayName: "Monday",
          sessionType: "push",
          status: "deferred" as const,
          retryable: true,
          error: "Approval is still in progress. Retry to finish this day safely.",
        },
      ],
    }));
    const tool = {
      ...createApproveWeekPlanTool(),
      ctx: {
        userId: "test-user",
        runQuery: vi.fn(async () => ({ _id: "week-plan-1" })),
        runMutation: vi.fn(async () => null),
        runAction,
      },
    };

    await expect(
      tool.execute!({}, { toolCallId: "call-approve", messages: [] }),
    ).resolves.toMatchObject({
      success: false,
      failed: 0,
      schedulingFailed: 0,
      deferred: 1,
      results: [{ status: "deferred", retryable: true }],
    });
  });
});

describe("getWeekPlanDetailsTool", () => {
  test("returns calendar and workout statuses as distinct fields", async () => {
    const runQuery = vi.fn(async (ref: unknown) => {
      const name = getFunctionName(ref as never);
      if (name === "weekPlans:getByUserIdAndWeekStartInternal") {
        return {
          _id: "week-plan-1",
          weekStartDate: "2026-08-03",
          preferredSplit: "upper_lower",
          targetDays: 1,
          days: [
            {
              sessionType: "upper",
              status: "programmed",
              workoutPlanId: "workout-plan-1",
              estimatedDuration: 30,
            },
          ],
        };
      }
      if (name === "tonal/movementSync:getAllMovements") {
        return [];
      }
      if (name === "workoutPlans:getById") {
        return { blocks: [], status: "pushed" };
      }
      throw new Error(`Unexpected query: ${name}`);
    });
    const tool = {
      ...createGetWeekPlanDetailsTool("UTC"),
      ctx: {
        userId: "test-user",
        runQuery,
        runMutation: vi.fn(async () => null),
        runAction: vi.fn(async () => null),
      },
    };

    const result = await tool.execute!({}, { toolCallId: "call-details", messages: [] });

    expect(result).toMatchObject({
      found: true,
      plan: {
        days: [{ status: "programmed", workoutStatus: "pushed" }],
      },
    });
  });
});

describe("deleteWeekPlanTool", () => {
  test("reports a guarded deletion as deleted false with its message", async () => {
    const tool = {
      ...deleteWeekPlanTool,
      ctx: {
        userId: "test-user",
        runQuery: vi.fn(async () => ({ _id: "week-plan-1" })),
        runMutation: vi.fn(async () => ({
          ok: false as const,
          error: "Scheduled workouts cannot be deleted",
        })),
        runAction: vi.fn(),
      },
    };

    await expect(tool.execute!({}, { toolCallId: "call-delete", messages: [] })).resolves.toEqual({
      deleted: false,
      message: "Scheduled workouts cannot be deleted",
    });
  });
});
