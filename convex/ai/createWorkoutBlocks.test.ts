import { describe, expect, it } from "vitest";
import { resolveWorkoutBlocks, type WorkoutInputBlock } from "./createWorkoutBlocks";
import { TONAL_REST_MOVEMENT_ID } from "../tonal/transforms";

const exercise = (overrides: Partial<WorkoutInputBlock["exercises"][number]>) => ({
  sets: 1,
  spotter: false,
  eccentric: false,
  warmUp: false,
  ...overrides,
});

describe("resolveWorkoutBlocks", () => {
  it("resolves the Rest sentinel by movementId without a name", () => {
    const blocks: WorkoutInputBlock[] = [
      { exercises: [exercise({ movementId: TONAL_REST_MOVEMENT_ID })] },
    ];

    const result = resolveWorkoutBlocks(blocks, []);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.blocks[0].exercises[0].movementId).toBe(TONAL_REST_MOVEMENT_ID);
    }
  });

  it("reports a not-found exercise by its name when it is not in the catalog", () => {
    const blocks: WorkoutInputBlock[] = [
      { exercises: [exercise({ name: "Nonexistent Movement XYZ" })] },
    ];

    const result = resolveWorkoutBlocks(blocks, []);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Nonexistent Movement XYZ");
    }
  });
});
