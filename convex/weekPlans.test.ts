/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  getWeekStartDateString,
  getWeekStartDateStringInTimezone,
  isValidWeekStartDateString,
} from "./weekPlans";
import { getDateStringInTimezone } from "./weekPlanHelpers";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

const emptyDays = (): Doc<"weekPlans">["days"] =>
  Array.from({ length: 7 }, () => ({
    sessionType: "rest" as const,
    status: "programmed" as const,
  }));

async function seedRelinkCase(
  t: ReturnType<typeof convexTest>,
  workout: Partial<Doc<"workoutPlans">> = {},
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {});
    const currentWorkoutPlanId = await ctx.db.insert("workoutPlans", {
      userId,
      title: "Current workout",
      blocks: [],
      status: "draft",
      createdAt: 1,
      ...workout,
    });
    const nextWorkoutPlanId = await ctx.db.insert("workoutPlans", {
      userId,
      title: "Next workout",
      blocks: [],
      status: "draft",
      createdAt: 2,
    });
    const days = emptyDays();
    days[0] = { ...days[0], workoutPlanId: currentWorkoutPlanId };
    const weekPlanId = await ctx.db.insert("weekPlans", {
      userId,
      weekStartDate: "2026-07-27",
      preferredSplit: "ppl",
      targetDays: 3,
      days,
      createdAt: 1,
      updatedAt: 1,
    });
    return { userId, currentWorkoutPlanId, nextWorkoutPlanId, weekPlanId, days };
  });
}

function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  return t.withIdentity({ subject: `${userId}|session` });
}

describe("isValidWeekStartDateString", () => {
  it("accepts valid YYYY-MM-DD", () => {
    expect(isValidWeekStartDateString("2026-03-09")).toBe(true);
    expect(isValidWeekStartDateString("2025-01-01")).toBe(true);
  });

  it("rejects non-YYYY-MM-DD strings", () => {
    expect(isValidWeekStartDateString("not-a-date")).toBe(false);
    expect(isValidWeekStartDateString("03-09-2026")).toBe(false);
    expect(isValidWeekStartDateString("2026/03/09")).toBe(false);
  });

  it("rejects invalid calendar dates", () => {
    expect(isValidWeekStartDateString("2026-02-30")).toBe(false);
    expect(isValidWeekStartDateString("2026-13-01")).toBe(false);
  });
});

describe("getWeekStartDateString", () => {
  it("returns Monday for a Monday date", () => {
    const monday = new Date("2026-03-09T12:00:00Z");
    expect(getWeekStartDateString(monday)).toBe("2026-03-09");
  });

  it("returns previous Monday for a Wednesday", () => {
    const wednesday = new Date("2026-03-11T12:00:00Z");
    expect(getWeekStartDateString(wednesday)).toBe("2026-03-09");
  });

  it("returns Monday of the week containing a Sunday", () => {
    const sunday = new Date("2026-03-08T12:00:00Z");
    expect(getWeekStartDateString(sunday)).toBe("2026-03-02");
  });

  it("returns same week Monday for Saturday", () => {
    const saturday = new Date("2026-03-14T12:00:00Z");
    expect(getWeekStartDateString(saturday)).toBe("2026-03-09");
  });
});

describe("getWeekStartDateStringInTimezone", () => {
  it("uses the user's Sunday when UTC has already reached Monday", () => {
    const mondayInUtc = new Date("2026-03-09T01:00:00.000Z");

    expect(getWeekStartDateStringInTimezone(mondayInUtc, "America/Denver")).toBe("2026-03-02");
    expect(getWeekStartDateStringInTimezone(mondayInUtc, "UTC")).toBe("2026-03-09");
  });
});

describe("getDateStringInTimezone", () => {
  it("returns the local calendar date and falls back to UTC for invalid timezones", () => {
    const instant = new Date("2026-08-03T01:00:00.000Z");

    expect(getDateStringInTimezone(instant, "America/Los_Angeles")).toBe("2026-08-02");
    expect(getDateStringInTimezone(instant, "Not/A_Timezone")).toBe("2026-08-03");
  });
});

describe("public week-plan relink guards", () => {
  it("rejects create with incoming scheduling evidence before inserting the week", async () => {
    const t = convexTest(schema, modules);
    const { userId, scheduledWorkoutPlanId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {});
      const scheduledWorkoutPlanId = await ctx.db.insert("workoutPlans", {
        userId,
        title: "Already scheduled",
        blocks: [],
        status: "pushed",
        tonalScheduledDate: "2026-08-03",
        createdAt: 1,
      });
      return { userId, scheduledWorkoutPlanId };
    });
    const days = emptyDays();
    days[0] = { ...days[0], workoutPlanId: scheduledWorkoutPlanId };

    await expect(
      withUser(t, userId).mutation(api.weekPlans.create, {
        weekStartDate: "2026-08-03",
        preferredSplit: "ppl",
        targetDays: 1,
        days,
      }),
    ).rejects.toThrow("Scheduled workouts cannot be linked");

    await expect(t.run((ctx) => ctx.db.query("weekPlans").collect())).resolves.toEqual([]);
  });

  it("rejects linking a claimed workout into an empty slot without patching metadata", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRelinkCase(t);
    await t.run(async (ctx) => {
      const week = await ctx.db.get(seeded.weekPlanId);
      if (!week) throw new Error("Missing week fixture");
      const days = emptyDays();
      await ctx.db.patch(seeded.weekPlanId, { days });
      await ctx.db.patch(seeded.nextWorkoutPlanId, {
        tonalSchedulingClaim: {
          claimId: "incoming-claim",
          workoutId: "tonal-next",
          scheduledDate: "2026-07-27",
          phase: "checking",
          leaseExpiresAt: 100,
        },
      });
    });

    await expect(
      withUser(t, seeded.userId).mutation(api.weekPlans.linkWorkoutPlanToDay, {
        weekPlanId: seeded.weekPlanId,
        dayIndex: 0,
        workoutPlanId: seeded.nextWorkoutPlanId,
        status: "completed",
        estimatedDuration: 45,
      }),
    ).rejects.toThrow("Workout scheduling is in progress");

    const stored = await t.run((ctx) => ctx.db.get(seeded.weekPlanId));
    expect(stored?.days[0]).toEqual({ sessionType: "rest", status: "programmed" });
  });

  it("rejects update with an incoming scheduled replacement atomically", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRelinkCase(t);
    await t.run((ctx) =>
      ctx.db.patch(seeded.nextWorkoutPlanId, { tonalWorkoutSignupId: "incoming-signup" }),
    );
    const days = seeded.days.map((day) => ({ ...day }));
    days[0] = { ...days[0], workoutPlanId: seeded.nextWorkoutPlanId };

    await expect(
      withUser(t, seeded.userId).mutation(api.weekPlans.update, {
        weekPlanId: seeded.weekPlanId,
        days,
      }),
    ).rejects.toThrow("Scheduled workouts cannot be linked");

    const stored = await t.run((ctx) => ctx.db.get(seeded.weekPlanId));
    expect(stored?.days[0]?.workoutPlanId).toBe(seeded.currentWorkoutPlanId);
  });

  it("rejects incoming workouts owned by another user on every public write path", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRelinkCase(t);
    const foreignWorkoutPlanId = await t.run(async (ctx) => {
      const otherUserId = await ctx.db.insert("users", {});
      return await ctx.db.insert("workoutPlans", {
        userId: otherUserId,
        title: "Foreign workout",
        blocks: [],
        status: "draft",
        createdAt: 3,
      });
    });
    const days = emptyDays();
    days[0] = { ...days[0], workoutPlanId: foreignWorkoutPlanId };
    const authed = withUser(t, seeded.userId);

    await expect(
      authed.mutation(api.weekPlans.create, {
        weekStartDate: "2026-08-03",
        preferredSplit: "ppl",
        targetDays: 1,
        days,
      }),
    ).rejects.toThrow("Workout plan not found or access denied");
    await expect(
      authed.mutation(api.weekPlans.update, { weekPlanId: seeded.weekPlanId, days }),
    ).rejects.toThrow("Workout plan not found or access denied");
    await expect(
      authed.mutation(api.weekPlans.linkWorkoutPlanToDay, {
        weekPlanId: seeded.weekPlanId,
        dayIndex: 0,
        workoutPlanId: foreignWorkoutPlanId,
      }),
    ).rejects.toThrow("Workout plan not found or access denied");

    const allWeeks = await t.run((ctx) => ctx.db.query("weekPlans").collect());
    expect(allWeeks).toHaveLength(1);
    expect(allWeeks[0]?.days[0]?.workoutPlanId).toBe(seeded.currentWorkoutPlanId);
  });

  it.each([
    {
      name: "pushed workout",
      workout: { status: "pushed" as const },
      error:
        "Only draft workouts can be relinked. Pushed or completed workouts stay on their Tonal Calendar date.",
      via: "link" as const,
    },
    {
      name: "scheduled workout",
      workout: { tonalWorkoutSignupId: "signup-1" },
      error: "Scheduled workouts cannot be relinked",
      via: "update" as const,
    },
    {
      name: "claimed workout",
      workout: {
        tonalSchedulingClaim: {
          claimId: "claim-1",
          workoutId: "tonal-1",
          scheduledDate: "2026-07-27",
          phase: "checking" as const,
          leaseExpiresAt: 100,
        },
      },
      error: "Workout scheduling is in progress",
      via: "link" as const,
    },
  ])("rejects public relinking for a $name", async ({ workout, error, via }) => {
    const t = convexTest(schema, modules);
    const seeded = await seedRelinkCase(t, workout);
    const relink =
      via === "update"
        ? withUser(t, seeded.userId).mutation(api.weekPlans.update, {
            weekPlanId: seeded.weekPlanId,
            days: seeded.days.map((day, dayIndex) =>
              dayIndex === 0 ? { ...day, workoutPlanId: seeded.nextWorkoutPlanId } : day,
            ),
          })
        : withUser(t, seeded.userId).mutation(api.weekPlans.linkWorkoutPlanToDay, {
            weekPlanId: seeded.weekPlanId,
            dayIndex: 0,
            workoutPlanId: seeded.nextWorkoutPlanId,
          });

    await expect(relink).rejects.toThrow(error);

    const stored = await t.run((ctx) => ctx.db.get(seeded.weekPlanId));
    expect(stored?.days[0]?.workoutPlanId).toBe(seeded.currentWorkoutPlanId);
  });

  it("allows replacing a safe draft through update", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRelinkCase(t);
    const days = seeded.days.map((day) => ({ ...day }));
    days[0] = { ...days[0], workoutPlanId: seeded.nextWorkoutPlanId };

    await expect(
      withUser(t, seeded.userId).mutation(api.weekPlans.update, {
        weekPlanId: seeded.weekPlanId,
        days,
      }),
    ).resolves.toBe(seeded.weekPlanId);

    const stored = await t.run((ctx) => ctx.db.get(seeded.weekPlanId));
    expect(stored?.days[0]?.workoutPlanId).toBe(seeded.nextWorkoutPlanId);
  });

  it("does not partially relink earlier days when a later protected day blocks update", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRelinkCase(t);
    const { protectedWorkoutPlanId, laterReplacementPlanId } = await t.run(async (ctx) => {
      const protectedWorkoutPlanId = await ctx.db.insert("workoutPlans", {
        userId: seeded.userId,
        title: "Protected workout",
        blocks: [],
        status: "pushed",
        createdAt: 3,
      });
      const laterReplacementPlanId = await ctx.db.insert("workoutPlans", {
        userId: seeded.userId,
        title: "Later replacement",
        blocks: [],
        status: "draft",
        createdAt: 4,
      });
      const days = seeded.days.map((day) => ({ ...day }));
      days[1] = { ...days[1], workoutPlanId: protectedWorkoutPlanId };
      await ctx.db.patch(seeded.weekPlanId, { days });
      return { protectedWorkoutPlanId, laterReplacementPlanId };
    });
    const proposedDays = seeded.days.map((day) => ({ ...day }));
    proposedDays[0] = { ...proposedDays[0], workoutPlanId: seeded.nextWorkoutPlanId };
    proposedDays[1] = { ...proposedDays[1], workoutPlanId: laterReplacementPlanId };

    await expect(
      withUser(t, seeded.userId).mutation(api.weekPlans.update, {
        weekPlanId: seeded.weekPlanId,
        days: proposedDays,
      }),
    ).rejects.toThrow(
      "Only draft workouts can be relinked. Pushed or completed workouts stay on their Tonal Calendar date.",
    );

    const stored = await t.run((ctx) => ctx.db.get(seeded.weekPlanId));
    expect(stored?.days[0]?.workoutPlanId).toBe(seeded.currentWorkoutPlanId);
    expect(stored?.days[1]?.workoutPlanId).toBe(protectedWorkoutPlanId);
  });

  it("allows metadata updates when the guarded workout link is unchanged", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRelinkCase(t, { tonalScheduledDate: "2026-07-27" });

    await expect(
      withUser(t, seeded.userId).mutation(api.weekPlans.linkWorkoutPlanToDay, {
        weekPlanId: seeded.weekPlanId,
        dayIndex: 0,
        workoutPlanId: seeded.currentWorkoutPlanId,
        status: "completed",
        estimatedDuration: 45,
      }),
    ).resolves.toBe(seeded.weekPlanId);

    const stored = await t.run((ctx) => ctx.db.get(seeded.weekPlanId));
    expect(stored?.days[0]).toMatchObject({
      workoutPlanId: seeded.currentWorkoutPlanId,
      status: "completed",
      estimatedDuration: 45,
    });
  });

  it("never lets public writes downgrade a completed day", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedRelinkCase(t);
    const completedDays = seeded.days.map((day) => ({ ...day }));
    completedDays[0] = { ...completedDays[0], status: "completed" };
    await t.run((ctx) => ctx.db.patch(seeded.weekPlanId, { days: completedDays }));
    const downgradedDays = completedDays.map((day) => ({ ...day }));
    downgradedDays[0] = { ...downgradedDays[0], status: "programmed" };

    await expect(
      withUser(t, seeded.userId).mutation(api.weekPlans.update, {
        weekPlanId: seeded.weekPlanId,
        days: downgradedDays,
      }),
    ).rejects.toThrow("Completed week-plan days cannot be changed");
    await expect(
      withUser(t, seeded.userId).mutation(api.weekPlans.linkWorkoutPlanToDay, {
        weekPlanId: seeded.weekPlanId,
        dayIndex: 0,
        workoutPlanId: seeded.currentWorkoutPlanId,
        status: "programmed",
      }),
    ).rejects.toThrow("Completed week-plan days cannot be changed");
  });
});
