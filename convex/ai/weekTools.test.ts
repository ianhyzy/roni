import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { describe, expect, test, vi } from "vitest";
import { approveWeekPlanTool, deleteWeekPlanTool } from "./weekTools";

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
    tool: approveWeekPlanTool,
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
