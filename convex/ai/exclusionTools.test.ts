import type { ToolCtx } from "@convex-dev/agent";
import type { ToolExecutionOptions } from "ai";
import { describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Movement } from "../tonal/types";
import { TONAL_REST_MOVEMENT_ID } from "../tonal/transforms";
import {
  excludeExercisesTool,
  getExerciseExclusionsTool,
  unexcludeExercisesTool,
} from "./exclusionTools";

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

function buildCtx(
  runMutation: ReturnType<typeof vi.fn>,
  runQuery: ReturnType<typeof vi.fn> = vi.fn(async () => CATALOG),
) {
  return {
    runQuery,
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
  it("resolves exact catalog entries and persists them in one atomic batch", async () => {
    const runMutation = vi.fn(async (_reference: unknown, args: unknown) => {
      const { movementIds } = args as { movementIds?: string[] };
      if (!movementIds) return undefined;
      return movementIds.map((movementId) => ({
        movementId,
        movementName: movementId === "m-frogger" ? "Frogger" : "Racked Squat",
        muscleGroups: ["Legs"],
        createdAt: 1,
      }));
    });
    const ctx = buildCtx(runMutation);

    const result = await runTool(excludeExercisesTool, ctx, {
      exercises: [{ name: "Frogger" }, { movementId: "m-squat" }],
    });

    expect(result).toMatchObject({
      success: true,
      excluded: ["Frogger", "Racked Squat"],
      unresolved: [],
    });
    expect(runMutation).toHaveBeenCalledWith(internal.exerciseExclusions.addManyForUser, {
      userId: "user-1",
      movementIds: ["m-frogger", "m-squat"],
    });
    const batchWrites = runMutation.mock.calls.filter(([, args]) =>
      Array.isArray((args as { movementIds?: string[] }).movementIds),
    );
    expect(batchWrites).toHaveLength(1);
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
      ([, args]) => (args as { movementIds?: string[] })?.movementIds !== undefined,
    );
    expect(exclusionWrites).toHaveLength(0);
  });

  it("does not treat the catalog-exempt Rest sentinel as an excludable movement", async () => {
    const runMutation = vi.fn(async (_reference: unknown, _args: unknown) => []);
    const ctx = buildCtx(runMutation);

    const result = await runTool(excludeExercisesTool, ctx, {
      exercises: [{ movementId: TONAL_REST_MOVEMENT_ID }],
    });

    expect(result).toMatchObject({ success: false, excluded: [] });
    expect((result as { unresolved: string[] }).unresolved[0]).toContain("not found");
    const exclusionWrites = runMutation.mock.calls.filter(
      ([, args]) => (args as { movementIds?: string[] })?.movementIds !== undefined,
    );
    expect(exclusionWrites).toHaveLength(0);
  });

  it("prefers an exact catalog name over a copied valid movement ID", async () => {
    const runMutation = vi.fn(async (_reference: unknown, args: unknown) => {
      const { movementIds } = args as { movementIds?: string[] };
      return (movementIds ?? []).map((movementId) => ({
        movementId,
        movementName: "Frogger",
        muscleGroups: ["Legs"],
        createdAt: 1,
      }));
    });
    const ctx = buildCtx(runMutation);

    await runTool(excludeExercisesTool, ctx, {
      exercises: [{ movementId: "m-squat", name: "Frogger" }],
    });

    expect(runMutation).toHaveBeenCalledWith(internal.exerciseExclusions.addManyForUser, {
      userId: "user-1",
      movementIds: ["m-frogger"],
    });
  });

  it("excludes the resolvable exercises even when one reference is bad", async () => {
    const runMutation = vi.fn(async (_reference: unknown, args: unknown) => {
      const { movementIds } = args as { movementIds?: string[] };
      if (!movementIds) return undefined;
      return movementIds.map((movementId) => ({
        movementId,
        movementName: movementId === "m-frogger" ? "Frogger" : "Racked Squat",
        muscleGroups: ["Legs"],
        createdAt: 1,
      }));
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
      (args as { movementIds?: string[] }).movementIds ? [] : undefined,
    );
    const runQuery = vi.fn();
    const ctx = buildCtx(runMutation, runQuery);

    const result = await runTool(unexcludeExercisesTool, ctx, {
      movementIds: ["m-squat"],
    });

    expect(result).toMatchObject({ success: false, removed: [] });
    expect(runQuery).not.toHaveBeenCalled();
  });

  it("removes IDs returned by get_exercise_exclusions in one atomic batch", async () => {
    const runMutation = vi.fn(async (_reference: unknown, args: unknown) =>
      (args as { movementIds?: string[] }).movementIds
        ? [
            {
              movementId: "m-frogger",
              movementName: "Frogger",
              muscleGroups: ["Legs"],
              createdAt: 1,
            },
          ]
        : undefined,
    );
    const runQuery = vi.fn();
    const ctx = buildCtx(runMutation, runQuery);

    const result = await runTool(unexcludeExercisesTool, ctx, {
      movementIds: ["m-frogger", "not-excluded"],
    });

    expect(result).toMatchObject({ success: true, removed: ["Frogger"] });
    expect(result).not.toHaveProperty("unresolved");
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).toHaveBeenCalledWith(internal.exerciseExclusions.removeManyForUser, {
      userId: "user-1",
      movementIds: ["m-frogger", "not-excluded"],
    });
    const batchWrites = runMutation.mock.calls.filter(([, args]) =>
      Array.isArray((args as { movementIds?: string[] }).movementIds),
    );
    expect(batchWrites).toHaveLength(1);
  });
});

describe("getExerciseExclusionsTool", () => {
  it("returns stable movement IDs for a later unexclude call", async () => {
    const runMutation = vi.fn(async () => undefined);
    const runQuery = vi.fn(async () => [
      {
        movementId: "m-frogger",
        movementName: "Frogger",
        muscleGroups: ["Legs"],
        createdAt: 1,
      },
    ]);
    const ctx = buildCtx(runMutation, runQuery);

    const result = await runTool(getExerciseExclusionsTool, ctx, {});

    expect(result).toEqual({
      exclusions: [{ movementId: "m-frogger", name: "Frogger", muscleGroups: ["Legs"] }],
    });
  });

  it("describes exclusions as exact current catalog entries, not wildcard rules", () => {
    const description = (excludeExercisesTool as { description?: string }).description ?? "";

    expect(description).toContain("exact current Tonal catalog entries");
    expect(description).toContain("future catalog additions");
    expect(description).not.toContain("rules out a movement pattern");
  });
});
