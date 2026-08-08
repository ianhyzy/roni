import { describe, expect, it } from "vitest";
import { selectCooldownExercises, selectWarmupExercises } from "./exerciseSelection";
import type { Movement } from "../tonal/types";

const movementDefaults: Omit<
  Movement,
  "id" | "name" | "shortName" | "muscleGroups" | "skillLevel"
> = {
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

function movement(
  overrides: Partial<Movement> & Pick<Movement, "id" | "name" | "muscleGroups" | "skillLevel">,
): Movement {
  return { ...movementDefaults, shortName: overrides.shortName ?? overrides.name, ...overrides };
}

const CHEST_TRICEPS = ["Chest", "Triceps"];

const warmupCatalog = [
  movement({
    id: "w-jump",
    name: "Jumping Jack",
    muscleGroups: CHEST_TRICEPS,
    skillLevel: 1,
    trainingTypes: ["Warm-up"],
  }),
  movement({
    id: "w-sweep",
    name: "90-90 Arm Sweep",
    muscleGroups: CHEST_TRICEPS,
    skillLevel: 1,
    trainingTypes: ["Warm-up"],
  }),
];

// Warmup and cooldown blocks are prepended/appended to the same session as the
// main work, so an exclusion honored only by main-block selection still lands
// the banned movement in the user's workout.
describe("selectWarmupExercises exclusions", () => {
  it("honors excludeNameSubstrings so a restriction cannot leak back in via the warmup", () => {
    const ids = selectWarmupExercises({
      catalog: warmupCatalog,
      targetMuscleGroups: CHEST_TRICEPS,
      maxExercises: 2,
      constraints: { excludeNameSubstrings: ["jump"] },
    });

    expect(ids).toEqual(["w-sweep"]);
  });

  it("matches exclusion substrings case-insensitively", () => {
    const ids = selectWarmupExercises({
      catalog: warmupCatalog,
      targetMuscleGroups: CHEST_TRICEPS,
      maxExercises: 2,
      constraints: { excludeNameSubstrings: ["JUMPING"] },
    });

    expect(ids).toEqual(["w-sweep"]);
  });

  it("selects everything when no name exclusions are set", () => {
    const ids = selectWarmupExercises({
      catalog: warmupCatalog,
      targetMuscleGroups: CHEST_TRICEPS,
      maxExercises: 2,
    });

    expect(ids).toEqual(["w-jump", "w-sweep"]);
  });

  it("still applies movement-id and accessory exclusions", () => {
    const ids = selectWarmupExercises({
      catalog: warmupCatalog,
      targetMuscleGroups: CHEST_TRICEPS,
      maxExercises: 2,
      constraints: { excludeMovementIds: ["w-sweep"] },
    });

    expect(ids).toEqual(["w-jump"]);
  });
});

describe("selectCooldownExercises exclusions", () => {
  const cooldownCatalog = [
    movement({
      id: "c-hop",
      name: "Hop Down Stretch",
      muscleGroups: CHEST_TRICEPS,
      skillLevel: 1,
      trainingTypes: ["Recovery"],
    }),
    movement({
      id: "c-fold",
      name: "Forward Fold",
      muscleGroups: CHEST_TRICEPS,
      skillLevel: 1,
      trainingTypes: ["Recovery"],
    }),
  ];

  it("honors excludeNameSubstrings", () => {
    const ids = selectCooldownExercises({
      catalog: cooldownCatalog,
      targetMuscleGroups: CHEST_TRICEPS,
      maxExercises: 2,
      constraints: { excludeNameSubstrings: ["hop"] },
    });

    expect(ids).toEqual(["c-fold"]);
  });
});
