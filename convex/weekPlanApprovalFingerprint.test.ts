/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { getWorkoutApprovalFingerprint } from "./weekPlanHelpers";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const snapshot = {
  title: "Push day",
  blocks: [
    {
      exercises: [
        { movementId: "bench", sets: 3, reps: 8 },
        { movementId: "fly", sets: 2, reps: 12 },
      ],
    },
  ],
};

describe("getWorkoutApprovalFingerprint", () => {
  it("is stable for identical title and block snapshots", () => {
    const copy = structuredClone(snapshot);

    expect(getWorkoutApprovalFingerprint(snapshot)).toBe(getWorkoutApprovalFingerprint(copy));
    expect(getWorkoutApprovalFingerprint(snapshot)).toBe(
      JSON.stringify([snapshot.title, snapshot.blocks]),
    );
  });

  it.each([
    { label: "title", value: { ...snapshot, title: "Updated push day" } },
    {
      label: "nested block value",
      value: {
        ...snapshot,
        blocks: [
          {
            ...snapshot.blocks[0],
            exercises: [
              { ...snapshot.blocks[0].exercises[0], reps: 9 },
              snapshot.blocks[0].exercises[1],
            ],
          },
        ],
      },
    },
    {
      label: "exercise order",
      value: {
        ...snapshot,
        blocks: [{ exercises: [...snapshot.blocks[0].exercises].reverse() }],
      },
    },
  ])("changes when the $label changes", ({ value }) => {
    expect(getWorkoutApprovalFingerprint(value)).not.toBe(getWorkoutApprovalFingerprint(snapshot));
  });
});

function makeMovement(tonalId: string) {
  return {
    tonalId,
    name: tonalId,
    shortName: tonalId,
    muscleGroups: ["Chest"],
    skillLevel: 1,
    publishState: "published",
    sortOrder: 1,
    onMachine: true,
    inFreeLift: false,
    countReps: true,
    isTwoSided: false,
    isBilateral: true,
    isAlternating: false,
    descriptionHow: "",
    descriptionWhy: "",
    lastSyncedAt: 1,
  };
}

describe("replaceDraftWithPushed approval fingerprint", () => {
  it("preserves an in-place edited draft when approval captured an older snapshot", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", {}));
    const { draftId, pushedId, weekPlanId } = await t.run(async (ctx) => {
      await ctx.db.insert("movements", makeMovement("old-movement"));
      await ctx.db.insert("movements", makeMovement("new-movement"));
      const draftId = await ctx.db.insert("workoutPlans", {
        userId,
        title: "Approved draft",
        blocks: [{ exercises: [{ movementId: "old-movement", sets: 3, reps: 8 }] }],
        status: "draft",
        createdAt: 1,
      });
      const pushedId = await ctx.db.insert("workoutPlans", {
        userId,
        title: "Created replacement",
        blocks: [{ exercises: [{ movementId: "old-movement", sets: 3, reps: 8 }] }],
        status: "pushed",
        tonalWorkoutId: "tonal-replacement",
        createdAt: 2,
      });
      const weekPlanId = await ctx.db.insert("weekPlans", {
        userId,
        weekStartDate: "2026-04-20",
        preferredSplit: "ppl",
        targetDays: 1,
        days: [
          { sessionType: "push", status: "programmed", workoutPlanId: draftId },
          ...Array.from({ length: 6 }, () => ({
            sessionType: "rest" as const,
            status: "programmed" as const,
          })),
        ],
        createdAt: 1,
        updatedAt: 1,
      });
      return { draftId, pushedId, weekPlanId };
    });
    const approvedDraft = await t.run((ctx) => ctx.db.get(draftId));
    if (!approvedDraft) throw new Error("Missing draft fixture");
    const expectedDraftFingerprint = getWorkoutApprovalFingerprint(approvedDraft);

    await expect(
      t.mutation(internal.coach.weekModifications.swapExerciseInDraft, {
        userId,
        workoutPlanId: draftId,
        oldMovementId: "old-movement",
        newMovementId: "new-movement",
      }),
    ).resolves.toEqual({ ok: true });
    const weekBeforeReplace = await t.run((ctx) => ctx.db.get(weekPlanId));

    await expect(
      t.mutation(internal.weekPlanInternals.replaceDraftWithPushed, {
        userId,
        weekPlanId,
        dayIndex: 0,
        oldWorkoutPlanId: draftId,
        expectedDraftFingerprint,
        newWorkoutPlanId: pushedId,
      }),
    ).resolves.toEqual({
      status: "conflict",
      error:
        "The draft changed while approval was in progress. Retry approval to push the updated workout.",
    });

    const [weekAfterReplace, editedDraft, unlinkedReplacement] = await t.run((ctx) =>
      Promise.all([ctx.db.get(weekPlanId), ctx.db.get(draftId), ctx.db.get(pushedId)]),
    );
    expect(weekAfterReplace).toEqual(weekBeforeReplace);
    expect(weekAfterReplace?.days[0].workoutPlanId).toBe(draftId);
    expect(editedDraft?.blocks[0].exercises[0].movementId).toBe("new-movement");
    expect(unlinkedReplacement?.status).toBe("pushed");
    expect(weekAfterReplace?.days.some((day) => day.workoutPlanId === pushedId)).toBe(false);
  });
});
