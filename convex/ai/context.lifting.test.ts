import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import { buildTrainingSnapshot } from "./context";

const gatherSnapshotInputsName = getFunctionName(internal.coachState.gatherSnapshotInputs);
const weekPlansName = getFunctionName(internal.weekPlans.getByUserIdAndWeekStartInternal);

describe("manual lifting training context", () => {
  afterEach(() => vi.useRealTimers());

  test("injects manual lifting without merging it into Tonal recent workouts", async () => {
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
            activities: [
              {
                date: "2026-07-30",
                title: "Tonal Push",
                targetArea: "Upper",
                totalVolume: 5_000,
                totalDuration: 1_800,
              },
            ],
            liftingSessions: [
              {
                performedAt: new Date("2026-07-30T14:00:00.000Z").getTime(),
                calendarDate: "2026-07-30",
                title: "Garage Gym",
                durationMinutes: 45,
                exerciseCount: 1,
                setCount: 3,
                totalReps: 24,
                totalVolumeLbs: 3_600,
                exercises: [
                  {
                    name: "Barbell Squat",
                    setCount: 3,
                    totalReps: 24,
                    totalVolumeLbs: 3_600,
                  },
                ],
              },
            ],
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

    const manualStart = snapshot.indexOf("Manual Lifting (non-Tonal):");
    const tonalStart = snapshot.indexOf("Recent Workouts:");
    expect(manualStart).toBeGreaterThan(-1);
    expect(tonalStart).toBeGreaterThan(manualStart);
    expect(snapshot.slice(manualStart, tonalStart)).toContain("Garage Gym");
    expect(snapshot.slice(manualStart, tonalStart)).not.toContain("Tonal Push");
    expect(snapshot.slice(tonalStart)).toContain("Tonal Push");
    expect(snapshot.slice(tonalStart)).not.toContain("Garage Gym");
  });
});
