import type { StepResult, ToolSet } from "ai";
import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { type AccumulatorInit, RunAccumulator } from "./runTelemetry";

const INIT: AccumulatorInit = {
  runId: "run-1",
  userId: "user-1" as Id<"users">,
  threadId: "thread-1",
  messageId: "message-1",
  source: "chat",
  environment: "dev",
  startedAt: 1_700_000_000_000,
};

function classifyApproveWeekPlan(output: unknown) {
  const accumulator = new RunAccumulator(INIT);
  accumulator.onStepFinish({
    stepNumber: 0,
    model: { provider: "gemini", modelId: "gemini-2.5-flash" },
    toolCalls: [{ toolName: "approve_week_plan" }],
    toolResults: [{ toolName: "approve_week_plan", output }],
    finishReason: "stop",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  } as unknown as StepResult<ToolSet>);
  return accumulator.toRow().workoutPushOutcome;
}

describe("approve_week_plan workout outcomes", () => {
  it.each([
    {
      name: "preserves push success when only calendar scheduling fails",
      output: {
        success: false,
        pushed: 1,
        failed: 0,
        schedulingFailed: 1,
        deferred: 0,
        results: [],
      },
      expected: "pushed",
    },
    {
      name: "keeps a non-scheduling approval failure classified as failed",
      output: {
        success: false,
        pushed: 0,
        failed: 0,
        schedulingFailed: 0,
        deferred: 0,
        results: [],
      },
      expected: "failed",
    },
    {
      name: "classifies a fully deferred approval as no push outcome",
      output: {
        success: false,
        pushed: 0,
        failed: 0,
        schedulingFailed: 0,
        deferred: 2,
        results: [],
      },
      expected: "none",
    },
    {
      name: "preserves completed pushes when later days are deferred",
      output: {
        success: false,
        pushed: 1,
        failed: 0,
        schedulingFailed: 0,
        deferred: 2,
        results: [],
      },
      expected: "pushed",
    },
  ])("$name", ({ output, expected }) => {
    expect(classifyApproveWeekPlan(output)).toBe(expected);
  });
});
