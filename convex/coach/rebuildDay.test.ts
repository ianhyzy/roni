/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

// Vite normalizes same-directory glob keys to "./foo.ts" instead of
// "../coach/foo.ts", which breaks convex-test module resolution.
// Remap ./foo.ts -> ../coach/foo.ts to match the expected path format.
const rawModules = import.meta.glob("../**/*.*s");
const modules: typeof rawModules = {};
for (const [key, value] of Object.entries(rawModules)) {
  modules[key.startsWith("./") ? "../coach/" + key.slice(2) : key] = value;
}

const FIXTURE_NOW = 1_775_772_000_000;

type ProgrammedRestDay = {
  sessionType: "rest";
  status: "programmed";
};

type ProgrammedRecoveryDay = {
  sessionType: "recovery";
  status: "programmed";
};

function programmedRestDay(): ProgrammedRestDay {
  return {
    sessionType: "rest",
    status: "programmed",
  };
}

function programmedRecoveryDay(): ProgrammedRecoveryDay {
  return {
    sessionType: "recovery",
    status: "programmed",
  };
}

function movementDoc(
  tonalId: string,
  overrides: { name?: string; muscleGroups?: string[]; countReps?: boolean } = {},
) {
  const name = overrides.name ?? tonalId;
  return {
    tonalId,
    name,
    shortName: name,
    muscleGroups: overrides.muscleGroups ?? ["Back"],
    countReps: overrides.countReps ?? true,
    skillLevel: 1,
    onMachine: false,
    inFreeLift: false,
    isTwoSided: false,
    isBilateral: true,
    isAlternating: false,
    publishState: "published",
    sortOrder: 0,
    descriptionHow: "",
    descriptionWhy: "",
    nameSearchText: name.toLowerCase(),
    muscleGroupsSearchText: (overrides.muscleGroups ?? ["Back"]).join(" ").toLowerCase(),
    trainingTypesSearchText: "strength",
    lastSyncedAt: FIXTURE_NOW,
  };
}

async function createActiveWeek(
  t: ReturnType<typeof convexTest>,
  sessionType: "full_body" | "legs" = "full_body",
) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "u@t" }));
  const oldPlanId = await t.run((ctx) =>
    ctx.db.insert("workoutPlans", {
      userId,
      title: "Old",
      blocks: [{ exercises: [{ movementId: "mov-old", sets: 3, reps: 10 }] }],
      status: "draft",
      createdAt: FIXTURE_NOW,
    }),
  );
  const weekPlanId = await t.run((ctx) =>
    ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: "2026-04-27",
      preferredSplit: "full_body",
      targetDays: 1,
      days: [
        { sessionType, status: "programmed", workoutPlanId: oldPlanId },
        ...Array.from({ length: 6 }, programmedRestDay),
      ],
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW,
    }),
  );
  return { userId, oldPlanId, weekPlanId };
}

describe("rebuildDay", () => {
  it("replaces a day's workoutPlan with a new draft built from explicit blocks", async () => {
    const t = convexTest(schema, modules);

    await t.run(async (ctx) => {
      for (const id of ["mov-warmup", "mov-main"]) {
        await ctx.db.insert("movements", movementDoc(id, { countReps: id === "mov-main" }));
      }
    });

    const { userId, oldPlanId, weekPlanId } = await createActiveWeek(t);

    const result = await t.action(internal.coach.rebuildDay.rebuildDay, {
      userId,
      weekPlanId,
      dayIndex: 0,
      title: "Monday Rebuilt",
      blocks: [
        { exercises: [{ movementId: "mov-warmup", sets: 2, duration: 30, warmUp: true }] },
        { exercises: [{ movementId: "mov-main", sets: 3, reps: 10 }] },
      ],
    });

    expect(result.ok).toBe(true);

    const wp = await t.run((ctx) => ctx.db.get(weekPlanId));
    const newPlanId = wp!.days[0].workoutPlanId!;
    expect(newPlanId).not.toEqual(oldPlanId);

    const newPlan = await t.run((ctx) => ctx.db.get(newPlanId));
    expect(newPlan!.title).toBe("Monday Rebuilt");
    expect(newPlan!.blocks).toHaveLength(2);
    expect(newPlan!.blocks[0].exercises[0].warmUp).toBe(true);
    expect(newPlan!.status).toBe("draft");
  });

  it("repairs fabricated movement IDs from exact exercise names", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("movements", movementDoc("mov-leg-press", { name: "Leg Press" }));
    });
    const { userId, weekPlanId } = await createActiveWeek(t, "legs");
    const result = await t.action(internal.coach.rebuildDay.rebuildDay, {
      userId,
      weekPlanId,
      dayIndex: 0,
      blocks: [
        { exercises: [{ movementId: "fabricated-leg-id", name: "Leg Press", sets: 3, reps: 10 }] },
      ],
    });
    expect(result.ok).toBe(true);
    const wp = await t.run((ctx) => ctx.db.get(weekPlanId));
    const newPlan = await t.run((ctx) => ctx.db.get(wp!.days[0].workoutPlanId!));
    expect(newPlan!.blocks[0].exercises[0]).toMatchObject({
      movementId: "mov-leg-press",
      reps: 10,
    });
    expect(newPlan!.blocks[0].exercises[0]).not.toHaveProperty("name");
  });

  it("returns guidance when exercise names cannot be resolved", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId } = await createActiveWeek(t);

    const result = await t.action(internal.coach.rebuildDay.rebuildDay, {
      userId,
      weekPlanId,
      dayIndex: 0,
      blocks: [{ exercises: [{ movementId: "fabricated-id", name: "Missing Movement", sets: 3 }] }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected rebuildDay to fail");
    expect(result.error).toContain("Could not resolve 1 of 1");
    expect(result.error).toContain("call search_exercises");
  });

  it("rejects malformed direct action block inputs", async () => {
    const t = convexTest(schema, modules);
    const { userId, weekPlanId } = await createActiveWeek(t);
    const cases = [
      { blocks: [], error: "blocks must contain" },
      { blocks: [{ exercises: [] }], error: "exercises must contain" },
      { blocks: [{ exercises: [{ movementId: "mov-x", sets: 0 }] }], error: "sets must be" },
    ];

    for (const testCase of cases) {
      const result = await t.action(internal.coach.rebuildDay.rebuildDay, {
        userId,
        weekPlanId,
        dayIndex: 0,
        blocks: testCase.blocks,
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected rebuildDay to fail");
      expect(result.error).toContain(testCase.error);
    }
  });

  it("does not delete the old workoutPlan until the new plan is linked", async () => {
    // Arrange
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("movements", movementDoc("mov-x"));
    });
    const { userId, oldPlanId, weekPlanId } = await createActiveWeek(t);

    // Act
    const result = await t.action(internal.coach.rebuildDay.rebuildDay, {
      userId,
      weekPlanId,
      dayIndex: 0,
      blocks: [{ exercises: [{ movementId: "mov-x", sets: 1, reps: 10 }] }],
    });

    // Assert: result is ok, the week plan now points at a NEW plan, and the old plan is deleted
    expect(result.ok).toBe(true);
    const wp = await t.run((ctx) => ctx.db.get(weekPlanId));
    expect(wp!.days[0].workoutPlanId).not.toEqual(oldPlanId);
    const oldPlanAfter = await t.run((ctx) => ctx.db.get(oldPlanId));
    expect(oldPlanAfter).toBeNull(); // deleted
  });

  it("returns error for rest day without throwing", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "u@t" }));
    const weekPlanId = await t.run((ctx) =>
      ctx.db.insert("weekPlans", {
        userId,
        weekStartDate: "2026-04-27",
        preferredSplit: "full_body",
        targetDays: 0,
        days: Array.from({ length: 7 }, programmedRestDay),
        createdAt: FIXTURE_NOW,
        updatedAt: FIXTURE_NOW,
      }),
    );

    const result = await t.action(internal.coach.rebuildDay.rebuildDay, {
      userId,
      weekPlanId,
      dayIndex: 0,
      blocks: [{ exercises: [{ movementId: "x", sets: 1, reps: 1 }] }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected rebuildDay to fail");
    expect(result.error).toMatch(/rest|recovery/i);
  });

  it("returns error for recovery day without throwing", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run((ctx) => ctx.db.insert("users", { email: "u@t" }));
    const weekPlanId = await t.run((ctx) =>
      ctx.db.insert("weekPlans", {
        userId,
        weekStartDate: "2026-04-27",
        preferredSplit: "full_body",
        targetDays: 0,
        days: Array.from({ length: 7 }, programmedRecoveryDay),
        createdAt: FIXTURE_NOW,
        updatedAt: FIXTURE_NOW,
      }),
    );

    const result = await t.action(internal.coach.rebuildDay.rebuildDay, {
      userId,
      weekPlanId,
      dayIndex: 3,
      blocks: [{ exercises: [{ movementId: "x", sets: 1, reps: 1 }] }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected rebuildDay to fail");
    expect(result.error).toMatch(/rest|recovery/i);
  });
});
