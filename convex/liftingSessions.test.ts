/// <reference types="vite/client" />
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

function createTest() {
  const testClient = convexTest(schema, modules);
  registerRateLimiter(testClient);
  return testClient;
}

async function createUser(testClient: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await testClient.run(async (ctx) => ctx.db.insert("users", {}));
}

function createSessionInput() {
  return {
    performedAt: 1_785_456_000_000,
    calendarDate: "2026-07-30",
    title: "  Garage strength  ",
    durationMinutes: 55,
    notes: "  Felt strong  ",
    exercises: [
      {
        name: "  Barbell squat  ",
        sets: [
          { kind: "warmup" as const, reps: 8, weightLbs: 95 },
          { kind: "working" as const, reps: 5, weightLbs: 185, rpe: 8 },
        ],
      },
      {
        name: "Pull-up",
        sets: [{ kind: "working" as const, reps: 10 }],
      },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("liftingSessions", () => {
  test("creates a normalized manual session with server-computed totals and order", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T18:00:00.000Z"));
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });

    const saved = await authed.mutation(api.liftingSessions.saveMine, {
      input: { kind: "create", session: createSessionInput() },
    });
    const detail = await authed.query(api.liftingSessions.getMine, {
      sessionId: saved.sessionId,
    });

    expect(saved).toMatchObject({
      source: "manual",
      title: "Garage strength",
      notes: "Felt strong",
      exerciseCount: 2,
      setCount: 3,
      totalReps: 23,
      totalVolumeLbs: 1_685,
    });
    expect(detail?.exercises.map((exercise) => exercise.name)).toEqual([
      "Barbell squat",
      "Pull-up",
    ]);
    expect(detail?.exercises[0]?.sets).toEqual([
      expect.objectContaining({ order: 0, kind: "warmup", reps: 8, weightLbs: 95, rpe: null }),
      expect.objectContaining({ order: 1, kind: "working", reps: 5, weightLbs: 185, rpe: 8 }),
    ]);
    expect(detail?.exercises[1]?.sets[0]).toMatchObject({
      order: 0,
      kind: "working",
      reps: 10,
      weightLbs: null,
      rpe: null,
    });
  });

  test("atomically replaces an owned session while preserving its creation time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T18:00:00.000Z"));
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });
    const created = await authed.mutation(api.liftingSessions.saveMine, {
      input: { kind: "create", session: createSessionInput() },
    });

    vi.setSystemTime(new Date("2026-07-30T19:00:00.000Z"));
    const replaced = await authed.mutation(api.liftingSessions.saveMine, {
      input: {
        kind: "replace",
        sessionId: created.sessionId,
        session: {
          ...createSessionInput(),
          title: "Revised session",
          notes: "   ",
          exercises: [
            {
              name: "Deadlift",
              sets: [{ kind: "working", reps: 3, weightLbs: 315 }],
            },
          ],
        },
      },
    });
    const detail = await authed.query(api.liftingSessions.getMine, {
      sessionId: created.sessionId,
    });

    expect(replaced.createdAt).toBe(created.createdAt);
    expect(replaced.updatedAt).toBeGreaterThan(created.updatedAt);
    expect(replaced.notes).toBeNull();
    expect(replaced).toMatchObject({
      title: "Revised session",
      exerciseCount: 1,
      setCount: 1,
      totalReps: 3,
      totalVolumeLbs: 945,
    });
    expect(detail?.exercises).toHaveLength(1);
    expect(detail?.exercises[0]?.name).toBe("Deadlift");
  });

  test("enforces authentication and ownership without disclosing foreign sessions", async () => {
    const testClient = createTest();
    const ownerId = await createUser(testClient);
    const otherId = await createUser(testClient);
    const owner = testClient.withIdentity({ subject: `${ownerId}|session` });
    const other = testClient.withIdentity({ subject: `${otherId}|session` });
    const saved = await owner.mutation(api.liftingSessions.saveMine, {
      input: { kind: "create", session: createSessionInput() },
    });

    await expect(testClient.query(api.liftingSessions.listMine, {})).resolves.toEqual([]);
    await expect(
      testClient.query(api.liftingSessions.getMine, { sessionId: saved.sessionId }),
    ).resolves.toBeNull();
    await expect(
      testClient.mutation(api.liftingSessions.saveMine, {
        input: { kind: "create", session: createSessionInput() },
      }),
    ).rejects.toThrow("Not authenticated");
    await expect(
      other.query(api.liftingSessions.getMine, { sessionId: saved.sessionId }),
    ).resolves.toBeNull();
    await expect(
      other.mutation(api.liftingSessions.saveMine, {
        input: { kind: "replace", sessionId: saved.sessionId, session: createSessionInput() },
      }),
    ).rejects.toThrow("Lifting session not found");
    await expect(
      other.mutation(api.liftingSessions.deleteMine, { sessionId: saved.sessionId }),
    ).rejects.toThrow("Lifting session not found");
  });

  test.each([
    [
      "calendar date",
      { calendarDate: "2026-02-30" },
      "calendarDate must be a valid YYYY-MM-DD date",
    ],
    [
      "timestamp",
      { performedAt: Number.POSITIVE_INFINITY },
      "performedAt must be a valid timestamp",
    ],
    ["title", { title: "   " }, "title must be between 1 and 100 characters"],
    ["duration", { durationMinutes: 0 }, "durationMinutes must be an integer from 1 to 1440"],
    ["notes", { notes: "x".repeat(1_001) }, "notes must be 1000 characters or fewer"],
  ])("rejects invalid %s", async (_label, override, expectedMessage) => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });

    await expect(
      authed.mutation(api.liftingSessions.saveMine, {
        input: { kind: "create", session: { ...createSessionInput(), ...override } },
      }),
    ).rejects.toThrow(expectedMessage);
  });

  test("rejects invalid exercise, set, and payload bounds before writing", async () => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });
    const input = createSessionInput();

    await expect(
      authed.mutation(api.liftingSessions.saveMine, {
        input: {
          kind: "create",
          session: { ...input, exercises: [] },
        },
      }),
    ).rejects.toThrow("exercises must contain between 1 and 20 items");
    await expect(
      authed.mutation(api.liftingSessions.saveMine, {
        input: {
          kind: "create",
          session: {
            ...input,
            exercises: Array.from({ length: 21 }, () => input.exercises[0]!),
          },
        },
      }),
    ).rejects.toThrow("exercises must contain between 1 and 20 items");
    await expect(
      authed.mutation(api.liftingSessions.saveMine, {
        input: {
          kind: "create",
          session: {
            ...input,
            exercises: [{ name: " ", sets: input.exercises[0]!.sets }],
          },
        },
      }),
    ).rejects.toThrow("exercise name must be between 1 and 100 characters");
    await expect(
      authed.mutation(api.liftingSessions.saveMine, {
        input: {
          kind: "create",
          session: {
            ...input,
            exercises: [{ name: "Squat", sets: [] }],
          },
        },
      }),
    ).rejects.toThrow("sets must contain between 1 and 20 items");
    await expect(
      authed.mutation(api.liftingSessions.saveMine, {
        input: {
          kind: "create",
          session: {
            ...input,
            exercises: [
              {
                name: "Squat",
                sets: Array.from({ length: 21 }, () => ({ kind: "working" as const, reps: 5 })),
              },
            ],
          },
        },
      }),
    ).rejects.toThrow("sets must contain between 1 and 20 items");
    await expect(
      authed.mutation(api.liftingSessions.saveMine, {
        input: {
          kind: "create",
          session: {
            ...input,
            exercises: [{ name: "Squat", sets: [{ kind: "working", reps: 0 }] }],
          },
        },
      }),
    ).rejects.toThrow("reps must be an integer from 1 to 1000");
    await expect(
      authed.mutation(api.liftingSessions.saveMine, {
        input: {
          kind: "create",
          session: {
            ...input,
            exercises: [{ name: "Squat", sets: [{ kind: "working", reps: 5, weightLbs: 5001 }] }],
          },
        },
      }),
    ).rejects.toThrow("weightLbs must be between 0 and 5000");
    await expect(
      authed.mutation(api.liftingSessions.saveMine, {
        input: {
          kind: "create",
          session: {
            ...input,
            exercises: [{ name: "Squat", sets: [{ kind: "working", reps: 5, rpe: 11 }] }],
          },
        },
      }),
    ).rejects.toThrow("rpe must be between 1 and 10");

    const rows = await testClient.run(async (ctx) => ctx.db.query("liftingSessions").collect());
    expect(rows).toEqual([]);
  });

  test("lists bounded newest summaries and rejects an excessive limit", async () => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });

    await testClient.run(async (ctx) => {
      for (let index = 0; index < 12; index += 1) {
        await ctx.db.insert("liftingSessions", {
          userId,
          source: "manual",
          performedAt: index,
          calendarDate: "2026-07-30",
          title: `Session ${index}`,
          exerciseCount: 1,
          setCount: 1,
          totalReps: 5,
          totalVolumeLbs: 500,
          createdAt: index,
          updatedAt: index,
        });
      }
    });

    const defaultRows = await authed.query(api.liftingSessions.listMine, {});
    const twelveRows = await authed.query(api.liftingSessions.listMine, { limit: 12 });

    expect(defaultRows).toHaveLength(10);
    expect(defaultRows[0]?.title).toBe("Session 11");
    expect(twelveRows).toHaveLength(12);
    await expect(authed.query(api.liftingSessions.listMine, { limit: 51 })).rejects.toThrow(
      "limit must be an integer from 1 to 50",
    );
  });

  test("deletes an owned session and every child row", async () => {
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });
    const saved = await authed.mutation(api.liftingSessions.saveMine, {
      input: { kind: "create", session: createSessionInput() },
    });

    await authed.mutation(api.liftingSessions.deleteMine, { sessionId: saved.sessionId });

    await expect(
      authed.query(api.liftingSessions.getMine, { sessionId: saved.sessionId }),
    ).resolves.toBeNull();
    const counts = await testClient.run(async (ctx) =>
      Promise.all([
        ctx.db.query("liftingSessions").collect(),
        ctx.db.query("liftingExercises").collect(),
        ctx.db.query("liftingSets").collect(),
      ]),
    );
    expect(counts.map((rows) => rows.length)).toEqual([0, 0, 0]);
  });

  test("checks a pre-exhausted limiter before normalization without extra writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T18:00:00.000Z"));
    const testClient = createTest();
    const userId = await createUser(testClient);
    const authed = testClient.withIdentity({ subject: `${userId}|session` });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await authed.mutation(api.liftingSessions.saveMine, {
        input: {
          kind: "create",
          session: { ...createSessionInput(), title: `Session ${attempt}` },
        },
      });
    }
    let rejected: unknown;
    try {
      await authed.mutation(api.liftingSessions.saveMine, {
        input: {
          kind: "create",
          session: { ...createSessionInput(), title: " " },
        },
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    if (!(rejected instanceof Error)) throw new Error("Expected save rejection");
    expect(rejected.message).not.toContain("title must be between 1 and 100 characters");

    const rows = await testClient.run((ctx) =>
      Promise.all([
        ctx.db.query("liftingSessions").collect(),
        ctx.db.query("liftingExercises").collect(),
        ctx.db.query("liftingSets").collect(),
      ]),
    );
    expect(rows.map((tableRows) => tableRows.length)).toEqual([5, 10, 15]);
  });
});
