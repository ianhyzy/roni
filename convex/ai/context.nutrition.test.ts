import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { buildTrainingSnapshot } from "./context";
import { SNAPSHOT_MAX_CHARS } from "./snapshotHelpers";

const gatherSnapshotInputsName = getFunctionName(internal.coachState.gatherSnapshotInputs);
const weekPlansName = getFunctionName(internal.weekPlans.getByUserIdAndWeekStartInternal);

describe("nutrition training context", () => {
  afterEach(() => vi.useRealTimers());

  test("injects only supplied user-reported metrics with coaching guardrails", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-30T18:00:00.000Z") });
    const ctx = {
      runQuery: async (query: unknown) => {
        const queryName = getFunctionName(query as never);
        if (queryName === gatherSnapshotInputsName) {
          return {
            profile: {
              profileData: {
                firstName: "Alice",
                lastName: "Lifter",
                heightInches: 66,
                weightPounds: 150,
                level: "intermediate",
                workoutsPerWeek: 4,
              },
            },
            scores: [],
            readiness: null,
            activities: [],
            liftingSessions: [],
            nutrition: {
              days: [
                {
                  calendarDate: "2026-07-30",
                  caloriesKcal: 0,
                  proteinGrams: 160,
                  notes: "private nutrition note",
                  updatedAt: 1,
                },
              ],
              targets: { proteinGrams: 180 },
            },
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
        if (queryName === weekPlansName) return null;
        return [];
      },
    };

    const snapshot = await buildTrainingSnapshot(ctx as never, "user-1", "America/Denver");

    expect(snapshot).toContain("Nutrition (user-reported):");
    expect(snapshot).toContain("Targets (self-set): 180g protein");
    expect(snapshot).toContain("[TODAY] 2026-07-30 | 0 kcal | 160g protein");
    expect(snapshot).toContain("missing days/metrics are unknown, not zero");
    expect(snapshot).toContain("do not diagnose deficiencies or give medical/dietetic advice");
    expect(snapshot).not.toContain("private nutrition note");
    expect(snapshot).not.toContain("0g carbs");
    expect(snapshot).not.toContain("deficit");
    expect(snapshot).not.toContain("surplus");
  });

  test("omits nutrition context when no nutrition data is available", async () => {
    const ctx = {
      runQuery: async (query: unknown) => {
        if (getFunctionName(query as never) === gatherSnapshotInputsName) {
          return {
            profile: {
              profileData: {
                firstName: "Alice",
                lastName: "Lifter",
                heightInches: 66,
                weightPounds: 150,
                level: "intermediate",
                workoutsPerWeek: 4,
              },
            },
            scores: [],
            readiness: null,
            activities: [],
            liftingSessions: [],
            nutrition: { days: [], targets: null },
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
        return null;
      },
    };

    const snapshot = await buildTrainingSnapshot(ctx as never, "user-1");

    expect(snapshot).not.toContain("Nutrition (user-reported):");
  });

  test("drops nutrition context when higher-priority sections consume the trim budget", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-30T18:00:00.000Z") });
    const firstName = "A".repeat(8_700);
    const ctx = {
      runQuery: async (query: unknown) => {
        const queryName = getFunctionName(query as never);
        if (queryName === gatherSnapshotInputsName) {
          return {
            profile: {
              profileData: {
                firstName,
                lastName: "Lifter",
                heightInches: 66,
                weightPounds: 150,
                level: "intermediate",
                workoutsPerWeek: 4,
              },
            },
            scores: [],
            readiness: null,
            activities: [],
            liftingSessions: [],
            nutrition: {
              days: [
                {
                  calendarDate: "2026-07-30",
                  proteinGrams: 160,
                  updatedAt: 1,
                },
              ],
              targets: { proteinGrams: 180 },
            },
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
        if (queryName === weekPlansName) return null;
        return [];
      },
    };

    const snapshot = await buildTrainingSnapshot(ctx as never, "user-1", "America/Denver");

    expect(snapshot).toContain(`User: ${firstName}`);
    expect(snapshot.length).toBeLessThanOrEqual(SNAPSHOT_MAX_CHARS);
    expect(snapshot).not.toContain("Nutrition (user-reported):");
  });
});
