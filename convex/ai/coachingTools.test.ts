import type { ToolCtx } from "@convex-dev/agent";
import type { ToolExecutionOptions } from "ai";
import { describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { advanceTrainingBlockTool } from "./coachingTools";

describe("advanceTrainingBlockTool", () => {
  it("reports that no advancement occurred when there is no active block", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValueOnce({ advanced: false, transitioned: false, newBlock: null })
      .mockResolvedValueOnce(undefined);
    const ctx = {
      runMutation,
      userId: "user-1",
      threadId: "thread-1",
    } as unknown as ToolCtx;
    const boundTool = { ...advanceTrainingBlockTool, ctx };
    const execute = boundTool.execute;
    if (!execute) throw new Error("advance_training_block execute handler missing");

    const result = await execute.call(boundTool, {}, {
      toolCallId: "tool-call-1",
      messages: [],
      experimental_context: { runId: "run-1" },
    } as ToolExecutionOptions);

    expect(result).toEqual({ advanced: false, transitioned: false, newBlock: null });
    expect(runMutation).toHaveBeenNthCalledWith(1, internal.coach.periodization.advanceWeek, {
      userId: "user-1",
    });
    expect(runMutation).toHaveBeenNthCalledWith(
      2,
      internal.aiUsage.recordToolCall,
      expect.objectContaining({
        runId: "run-1",
        success: true,
        toolCallId: "tool-call-1",
        toolName: "advance_training_block",
      }),
    );
  });
});
