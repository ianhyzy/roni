import type { ToolCtx } from "@convex-dev/agent";
import type { ToolExecutionOptions } from "ai";
import { describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Movement } from "../tonal/types";
import { excludeExercisesTool, unexcludeExercisesTool } from "./exclusionTools";

const movementDefaults: Omit<Movement, "id" | "name" | "shortName" | "muscleGroups"> = {
  skillLevel: 1,
  inFreeLift: false,
  onMachine: true,
  countReps: true,
  isTwoSided: false,
  isBilateral: true,
  isAlternating: false,
  descriptionHow: "",
  descriptionWhy: "",
  thumbnailMediaUrl: "",
  publishState: "published",
  sortOrder: 0,
};

function movement(id: string, name: string): Movement {
  return { ...movementDefaults, id, name, shortName: name, muscleGroups: ["Legs"] };
}

const CATALOG: Movement[] = [movement("m-frogger", "Frogger"), movement("m-squat", "Racked Squat")];

const TOOL_OPTIONS = {
  toolCallId: "tool-call-1",
  messages: [],
  experimental_context: { runId: "run-1" },
} as ToolExecutionOptions;

function buildCtx(runMutation: ReturnType<typeof vi.fn>) {
  return {
    // The tools issue exactly one query: the movement catalog.
    runQuery: vi.fn(async () => CATALOG),
    runMutation,
    userId: "user-1",
    threadId: "thread-1",
  } as unknown as ToolCtx;
}

type ExecutableTool = {
  execute?: (
    this: unknown,
    input: never,
    options: ToolExecutionOptions,
  ) => unknown | PromiseLike<unknown>;
};

async function runTool(tool: unknown, ctx: ToolCtx, input: unknown): Promise<unknown> {
  const bound = { ...(tool as object), ctx } as ExecutableTool;
  const execute = bound.execute;
  if (!execute) throw new Error("execute handler missing");
  return await execute.call(bound, input as never, TOOL_OPTIONS);
}

describe("excludeExercisesTool", () => {
  it("resolves exercises by exact name and persists each exclusion", async () => {
    const runMutation = vi.fn(async (_reference: unknown, args: unknown) => {
      const { movementId } = args as { movementId?: string };
      if (!movementId) return undefined;
      return { movementId, movementName: "Frogger", muscleGroups: ["Legs"], createdAt: 1 };
    });
    const ctx = buildCtx(runMutation);

    const result = await runTool(excludeExercisesTool, ctx, {
      exercises: [{ name: "Frogger" }],
      reason: "no jumping",
    });

    expect(result).toMatchObject({ success: true, excluded: ["Frogger"], unresolved: [] });
    expect(runMutation).toHaveBeenCalledWith(internal.exerciseExclusions.addForUser, {
      userId: "user-1",
      movementId: "m-frogger",
    });
  });

  it("reports unresolved names instead of excluding a guessed movement", async () => {
    const runMutation = vi.fn(async (_reference: unknown, _args: unknown) => undefined);
    const ctx = buildCtx(runMutation);

    const result = await runTool(excludeExercisesTool, ctx, {
      exercises: [{ name: "Box Jump" }],
    });

    expect(result).toMatchObject({ success: false, excluded: [] });
    expect((result as { unresolved: string[] }).unresolved[0]).toContain("Box Jump");
    // Only the telemetry write should have happened — nothing carrying a movementId.
    const exclusionWrites = runMutation.mock.calls.filter(
      ([, args]) => (args as { movementId?: string })?.movementId !== undefined,
    );
    expect(exclusionWrites).toHaveLength(0);
  });

  it("excludes the resolvable exercises even when one reference is bad", async () => {
    const runMutation = vi.fn(async (_reference: unknown, args: unknown) => {
      const { movementId } = args as { movementId?: string };
      if (!movementId) return undefined;
      return {
        movementId,
        movementName: movementId === "m-frogger" ? "Frogger" : "Racked Squat",
        muscleGroups: ["Legs"],
        createdAt: 1,
      };
    });
    const ctx = buildCtx(runMutation);

    const result = await runTool(excludeExercisesTool, ctx, {
      exercises: [{ name: "Frogger" }, { name: "Not A Movement" }],
    });

    expect(result).toMatchObject({ success: true, excluded: ["Frogger"] });
    expect((result as { unresolved: string[] }).unresolved).toHaveLength(1);
  });
});

describe("unexcludeExercisesTool", () => {
  it("reports nothing removed when the exercise was not excluded", async () => {
    const runMutation = vi.fn(async (_reference: unknown, args: unknown) =>
      (args as { movementId?: string }).movementId ? { removed: false } : undefined,
    );
    const ctx = buildCtx(runMutation);

    const result = await runTool(unexcludeExercisesTool, ctx, {
      exercises: [{ name: "Racked Squat" }],
    });

    expect(result).toMatchObject({ success: false, removed: [] });
  });

  it("removes a previously excluded exercise", async () => {
    const runMutation = vi.fn(async (_reference: unknown, args: unknown) =>
      (args as { movementId?: string }).movementId
        ? { removed: true, movementName: "Frogger" }
        : undefined,
    );
    const ctx = buildCtx(runMutation);

    const result = await runTool(unexcludeExercisesTool, ctx, {
      exercises: [{ name: "Frogger" }],
    });

    expect(result).toMatchObject({ success: true, removed: ["Frogger"] });
  });
});
