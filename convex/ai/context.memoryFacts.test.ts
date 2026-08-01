import { describe, expect, it } from "vitest";
import { buildTrainingSnapshotWithMetadata } from "./context";

function emptyInputs() {
  return {
    profile: null,
    scores: [],
    readiness: null,
    activities: [],
    activeBlock: null,
    recentFeedback: [],
    activeGoals: [],
    activeInjuries: [],
    exerciseExclusions: [],
    externalActivities: [],
    recoveryInputs: { preferredSource: null, observations: [], checkIns: [] },
    memoryFacts: [],
  };
}

function profile() {
  return {
    profileData: {
      firstName: "Alice",
      lastName: "Lifter",
      heightInches: 66,
      weightPounds: 150,
      level: "intermediate",
      workoutsPerWeek: 4,
    },
  };
}

describe("training snapshot memory facts", () => {
  it("injects remembered preferences and reports their rendered count", async () => {
    const ctx = {
      runQuery: async () => ({
        ...emptyInputs(),
        profile: profile(),
        memoryFacts: [
          { fact: "The user dislikes Bulgarian split squats." },
          { fact: "The user prefers evening workouts." },
        ],
      }),
    };

    const result = await buildTrainingSnapshotWithMetadata(ctx as never, "user-1");

    expect(result.snapshot).toContain("Remembered Workout Preferences:");
    expect(result.snapshot).toContain("The user dislikes Bulgarian split squats.");
    expect(result.snapshot).toContain("The user prefers evening workouts.");
    expect(result.memoryFactsInjected).toBe(2);
  });

  it("keeps remembered preferences available after the Tonal profile is disconnected", async () => {
    const ctx = {
      runQuery: async () => ({
        ...emptyInputs(),
        memoryFacts: [{ fact: "The user prefers evening workouts." }],
      }),
    };

    const result = await buildTrainingSnapshotWithMetadata(ctx as never, "user-1");

    expect(result.snapshot).toContain("No Tonal profile linked yet");
    expect(result.snapshot).toContain("The user prefers evening workouts.");
    expect(result.memoryFactsInjected).toBe(1);
  });

  it("suppresses all remembered preferences while account deletion is in progress", async () => {
    const ctx = {
      runQuery: async () => ({
        ...emptyInputs(),
        deletionInProgress: true,
        memoryFacts: [{ fact: "The user prefers evening workouts." }],
      }),
    };

    const result = await buildTrainingSnapshotWithMetadata(ctx as never, "user-1");

    expect(result.snapshot).toBe("Account deletion is in progress.");
    expect(result.snapshot).not.toContain("evening workouts");
    expect(result.memoryFactsInjected).toBe(0);
  });

  it("reports zero injected facts when snapshot trimming drops the memory section", async () => {
    const ctx = {
      runQuery: async () => ({
        ...emptyInputs(),
        profile: profile(),
        memoryFacts: [{ fact: "x".repeat(100_000) }],
      }),
    };

    const result = await buildTrainingSnapshotWithMetadata(ctx as never, "user-1");

    expect(result.snapshot).not.toContain("Remembered Workout Preferences:");
    expect(result.memoryFactsInjected).toBe(0);
  });
});
