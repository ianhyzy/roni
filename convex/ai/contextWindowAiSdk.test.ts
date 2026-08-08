import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { generateText, type ModelMessage, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { estimateMessagesTokens, stripOrphanedToolCalls } from "./contextWindow";
import { buildSearchTelemetryContextWindow } from "./contextWindowSearchTelemetry";

const MODEL_RESULT = {
  content: [{ type: "text", text: "Done." }],
  finishReason: { unified: "stop", raw: "stop" },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
} satisfies LanguageModelV3GenerateResult;

describe("context-window compatibility with AI SDK approvals", () => {
  it("does not execute a completed tool again for a late approval response", async () => {
    const execute = vi.fn(async () => "pushed again");
    const messages = stripOrphanedToolCalls([
      { role: "user", content: "push it" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call-1", toolName: "approve_week_plan", input: {} },
          { type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "approve_week_plan",
            output: { type: "text", value: "already pushed" },
          },
        ],
      },
      { role: "assistant", content: "Push completed." },
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "approval-1", approved: true }],
      },
    ] satisfies ModelMessage[]);
    const model = new MockLanguageModelV3({ doGenerate: MODEL_RESULT });

    const result = await generateText({
      model,
      messages,
      tools: {
        approve_week_plan: tool({
          inputSchema: z.object({}),
          needsApproval: true,
          execute,
        }),
      },
    });
    const toolResultsSeenByModel = model.doGenerateCalls[0].prompt.flatMap((message) =>
      message.role === "assistant" || message.role === "tool"
        ? message.content.filter((part) => part.type === "tool-result")
        : [],
    );

    expect(execute).not.toHaveBeenCalled();
    expect(toolResultsSeenByModel).toHaveLength(1);
    expect(result.steps.flatMap((step) => step.toolResults)).toEqual([]);
  });

  it("removes windowed lifecycle orphans and re-merges their assistant neighbors", async () => {
    const latestUser: ModelMessage = { role: "user", content: "latest question" };
    const beforeOrphans: ModelMessage = { role: "assistant", content: "Before orphan parts." };
    const orphanResult: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "completed-call",
          toolName: "get_scores",
          output: { type: "text", value: "already read" },
        },
      ],
    };
    const afterOrphans: ModelMessage = { role: "assistant", content: "After orphan parts." };
    const finalResponse: ModelMessage = {
      role: "tool",
      content: [{ type: "tool-approval-response", approvalId: "approval-1", approved: true }],
    };
    const latestTurn = [latestUser, beforeOrphans, orphanResult, afterOrphans, finalResponse];
    const window = buildSearchTelemetryContextWindow({
      messages: [
        { role: "user", content: "older request" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", toolCallId: "completed-call", toolName: "get_scores", input: {} },
            {
              type: "tool-call",
              toolCallId: "approval-call",
              toolName: "approve_week_plan",
              input: {},
            },
            {
              type: "tool-approval-request",
              approvalId: "approval-1",
              toolCallId: "approval-call",
            },
          ],
        },
        ...latestTurn,
      ],
      searchMessages: [orphanResult],
      promptBudgetTokens: estimateMessagesTokens(latestTurn),
      reservedPromptTokens: 0,
    });
    const model = new MockLanguageModelV3({ doGenerate: MODEL_RESULT });

    await expect(generateText({ model, messages: window.messages })).resolves.toBeDefined();

    expect(window.messages).toEqual([
      latestUser,
      {
        role: "assistant",
        content: [
          { type: "text", text: "Before orphan parts." },
          { type: "text", text: "After orphan parts." },
        ],
      },
    ]);
    expect(window.searchUsed).toBe(false);
    expect(model.doGenerateCalls).toHaveLength(1);
  });
});
