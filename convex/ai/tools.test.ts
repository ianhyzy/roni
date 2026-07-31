import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { internal } from "../_generated/api";
import {
  createWorkoutTool,
  deleteWorkoutTool,
  KNOWN_TRAINING_TYPES,
  searchExercisesTool,
} from "./tools";

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

describe("searchExercisesTool input schema", () => {
  it("rejects 'Warm-up' as trainingType (not a real catalog tag)", () => {
    const parsed = (searchExercisesTool.inputSchema as z.ZodObject<z.ZodRawShape>).safeParse({
      trainingType: "Warm-up",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts the known catalog trainingTypes", () => {
    for (const t of KNOWN_TRAINING_TYPES) {
      const parsed = (searchExercisesTool.inputSchema as z.ZodObject<z.ZodRawShape>).safeParse({
        trainingType: t,
      });
      expect(parsed.success).toBe(true);
    }
  });
});

const WRITE_TOOL_CASES = [
  {
    name: "create_workout",
    tool: createWorkoutTool,
    input: {
      title: "Upper Body Strength",
      blocks: [
        {
          exercises: [
            {
              name: "Bench Press",
              sets: 3,
              reps: 10,
              spotter: false,
              eccentric: false,
              warmUp: false,
            },
          ],
        },
      ],
    },
  },
  {
    name: "delete_workout",
    tool: deleteWorkoutTool,
    input: { workoutId: "tonal-workout-id" },
  },
];

describe("write tool approval policy", () => {
  it.each(WRITE_TOOL_CASES)(
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

type DeleteToolContext = {
  userId: string;
  runQuery: (...args: unknown[]) => Promise<unknown>;
  runMutation: (...args: unknown[]) => Promise<unknown>;
  runAction: (...args: unknown[]) => Promise<unknown>;
};

type ExecutableDeleteTool = {
  execute: (
    input: { workoutId: string },
    options: { toolCallId: string; messages: [] },
  ) => Promise<unknown>;
};

async function executeDeleteWorkout(ctx: DeleteToolContext) {
  const executable = { ...(deleteWorkoutTool as object), ctx } as unknown as ExecutableDeleteTool;
  return await executable.execute(
    { workoutId: "tonal-workout-id" },
    { toolCallId: "delete-test", messages: [] },
  );
}

describe("deleteWorkoutTool scheduling preflight", () => {
  it("does not run the deletion action when weekly scheduling state blocks deletion", async () => {
    const runMutation = vi.fn(async () => null);
    const error =
      "This workout is linked to or scheduled by a weekly plan and cannot be deleted individually.";
    const runAction = vi.fn(async (..._args: unknown[]) => error);

    await expect(
      executeDeleteWorkout({
        userId: "user-id",
        runQuery: vi.fn(async () => null),
        runMutation,
        runAction,
      }),
    ).rejects.toThrow(error);

    expect(runAction).toHaveBeenCalledOnce();
    expect(getFunctionName(runAction.mock.calls[0][0] as never)).toBe(
      getFunctionName(internal.workoutPlans.getDeleteWorkoutBlocker),
    );
    expect(runAction.mock.calls[0][1]).toEqual({
      userId: "user-id",
      tonalWorkoutId: "tonal-workout-id",
    });
    expect(runMutation).toHaveBeenCalledOnce();
  });

  it("preserves the successful standalone deletion result", async () => {
    const runAction = vi.fn(async (ref: unknown, _args: unknown) =>
      getFunctionName(ref as never) ===
      getFunctionName(internal.workoutPlans.getDeleteWorkoutBlocker)
        ? null
        : { deleted: true as const },
    );

    await expect(
      executeDeleteWorkout({
        userId: "user-id",
        runQuery: vi.fn(async () => null),
        runMutation: vi.fn(async () => null),
        runAction,
      }),
    ).resolves.toEqual({ deleted: true });

    expect(runAction).toHaveBeenCalledTimes(2);
    expect(runAction.mock.calls.map(([ref]) => getFunctionName(ref as never))).toEqual([
      getFunctionName(internal.workoutPlans.getDeleteWorkoutBlocker),
      getFunctionName(internal.tonal.mutations.deleteWorkout),
    ]);
    expect(runAction.mock.calls[1]?.[1]).toEqual({
      userId: "user-id",
      workoutId: "tonal-workout-id",
    });
  });
});
