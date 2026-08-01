/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

describe("gatherSnapshotInputs manual lifting projection", () => {
  test("projects session and exercise totals without changing Tonal activities", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));
    const now = 1_785_436_800_000;

    await t.run(async (ctx) => {
      await ctx.db.insert("completedWorkouts", {
        userId,
        activityId: "tonal-activity-1",
        title: "Tonal Push",
        date: "2026-07-30",
        targetArea: "Upper",
        totalVolume: 5_000,
        totalDuration: 1_800,
        totalWork: 4_500,
        workoutType: "strength",
        syncedAt: now,
      });
      const sessionId = await ctx.db.insert("liftingSessions", {
        userId,
        source: "manual",
        performedAt: now - 1_000,
        calendarDate: "2026-07-30",
        title: "Garage Gym",
        durationMinutes: 45,
        exerciseCount: 1,
        setCount: 3,
        totalReps: 24,
        totalVolumeLbs: 3_600,
        createdAt: now,
        updatedAt: now,
      });
      const exerciseId = await ctx.db.insert("liftingExercises", {
        userId,
        sessionId,
        order: 0,
        name: "Barbell Squat",
        setCount: 3,
        totalReps: 24,
        totalVolumeLbs: 3_600,
      });
      await ctx.db.insert("liftingSets", {
        userId,
        sessionId,
        exerciseId,
        exerciseOrder: 0,
        order: 0,
        kind: "working",
        reps: 8,
        weightLbs: 150,
        rpe: 8,
      });
    });

    const inputs = await t.query(internal.coachState.gatherSnapshotInputs, { userId });

    expect(inputs.activities.map((activity) => activity.title)).toEqual(["Tonal Push"]);
    expect(inputs.liftingSessions).toEqual([
      {
        performedAt: now - 1_000,
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
    ]);
  });

  test("returns only the ten newest sessions and twenty exercises per session", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", {}));

    await t.run(async (ctx) => {
      for (let sessionIndex = 0; sessionIndex < 11; sessionIndex += 1) {
        const sessionId = await ctx.db.insert("liftingSessions", {
          userId,
          source: "manual",
          performedAt: sessionIndex,
          calendarDate: "2026-07-30",
          title: `Session ${sessionIndex}`,
          exerciseCount: sessionIndex === 10 ? 21 : 0,
          setCount: 0,
          totalReps: 0,
          totalVolumeLbs: 0,
          createdAt: sessionIndex,
          updatedAt: sessionIndex,
        });
        if (sessionIndex === 10) {
          for (let exerciseIndex = 0; exerciseIndex < 21; exerciseIndex += 1) {
            await ctx.db.insert("liftingExercises", {
              userId,
              sessionId,
              order: exerciseIndex,
              name: `Exercise ${exerciseIndex}`,
              setCount: 1,
              totalReps: 5,
              totalVolumeLbs: 500,
            });
          }
        }
      }
    });

    const inputs = await t.query(internal.coachState.gatherSnapshotInputs, { userId });

    expect(inputs.liftingSessions.map((session) => session.title)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Session ${10 - index}`),
    );
    expect(inputs.liftingSessions[0].exercises).toHaveLength(20);
    expect(inputs.liftingSessions[0].exercises[19]?.name).toBe("Exercise 19");
  });

  test("returns no manual sessions while account deletion is in progress", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) => ctx.db.insert("users", { deletionInProgress: true }));
    await t.run(async (ctx) => {
      await ctx.db.insert("liftingSessions", {
        userId,
        source: "manual",
        performedAt: 1,
        calendarDate: "2026-07-30",
        title: "Private Session",
        exerciseCount: 0,
        setCount: 0,
        totalReps: 0,
        totalVolumeLbs: 0,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    const inputs = await t.query(internal.coachState.gatherSnapshotInputs, { userId });

    expect(inputs.deletionInProgress).toBe(true);
    expect(inputs.liftingSessions).toEqual([]);
  });
});
