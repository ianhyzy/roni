/// <reference types="vite/client" />
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

function createTest() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

async function createUser(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await t.run(async (ctx) => ctx.db.insert("users", {}));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("recoveryCheckIns", () => {
  test("upserts one check-in per user and calendar date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T15:00:00.000Z"));
    const t = createTest();
    const userId = await createUser(t);
    const authed = t.withIdentity({ subject: `${userId}|session` });

    const first = await authed.mutation(api.recoveryCheckIns.upsertMine, {
      calendarDate: "2026-07-30",
      energy: 4,
      soreness: 2,
      stress: 3,
      notes: "  Ready to train  ",
    });
    vi.setSystemTime(new Date("2026-07-30T16:00:00.000Z"));
    const second = await authed.mutation(api.recoveryCheckIns.upsertMine, {
      calendarDate: "2026-07-30",
      energy: 2,
      soreness: 4,
      stress: 4,
    });
    const listed = await authed.query(api.recoveryCheckIns.listRecentMine, {});

    expect(first.notes).toBe("Ready to train");
    expect(second).toMatchObject({
      calendarDate: "2026-07-30",
      energy: 2,
      soreness: 4,
      stress: 4,
      notes: null,
      createdAt: first.createdAt,
    });
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(listed).toEqual([second]);
  });

  test("rejects unauthenticated writes", async () => {
    const t = createTest();

    await expect(
      t.mutation(api.recoveryCheckIns.upsertMine, {
        calendarDate: "2026-07-30",
        energy: 3,
        soreness: 3,
        stress: 3,
      }),
    ).rejects.toThrow("Not authenticated");
  });

  test("validates calendar dates, integer scores, and note length", async () => {
    const t = createTest();
    const userId = await createUser(t);
    const authed = t.withIdentity({ subject: `${userId}|session` });
    const base = { calendarDate: "2026-07-30", energy: 3, soreness: 3, stress: 3 };

    await expect(
      authed.mutation(api.recoveryCheckIns.upsertMine, {
        ...base,
        calendarDate: "2026-02-30",
      }),
    ).rejects.toThrow("calendarDate must be a valid YYYY-MM-DD date");
    await expect(
      authed.mutation(api.recoveryCheckIns.upsertMine, { ...base, energy: 0 }),
    ).rejects.toThrow("energy must be an integer from 1 to 5");
    await expect(
      authed.mutation(api.recoveryCheckIns.upsertMine, { ...base, soreness: 2.5 }),
    ).rejects.toThrow("soreness must be an integer from 1 to 5");
    await expect(
      authed.mutation(api.recoveryCheckIns.upsertMine, { ...base, notes: "x".repeat(501) }),
    ).rejects.toThrow("notes must be 500 characters or fewer");
  });

  test("accepts UTC tomorrow but rejects dates more than one UTC day ahead", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T23:59:59.000Z"));
    const t = createTest();
    const userId = await createUser(t);
    const authed = t.withIdentity({ subject: `${userId}|session` });
    const scores = { energy: 3, soreness: 3, stress: 3 };

    await expect(
      authed.mutation(api.recoveryCheckIns.upsertMine, {
        calendarDate: "2026-07-31",
        ...scores,
      }),
    ).resolves.toMatchObject({ calendarDate: "2026-07-31" });
    await expect(
      authed.mutation(api.recoveryCheckIns.upsertMine, {
        calendarDate: "2026-08-01",
        ...scores,
      }),
    ).rejects.toThrow("calendarDate cannot be more than one UTC day in the future");
  });

  test("does not expose another user's check-ins", async () => {
    const t = createTest();
    const firstUserId = await createUser(t);
    const secondUserId = await createUser(t);
    const first = t.withIdentity({ subject: `${firstUserId}|session` });
    const second = t.withIdentity({ subject: `${secondUserId}|session` });

    await first.mutation(api.recoveryCheckIns.upsertMine, {
      calendarDate: "2026-07-30",
      energy: 1,
      soreness: 5,
      stress: 4,
      notes: "Private note",
    });

    await expect(second.query(api.recoveryCheckIns.listRecentMine, {})).resolves.toEqual([]);
  });

  test("returns at most fourteen check-ins in most-recently-updated order", async () => {
    const t = createTest();
    const userId = await createUser(t);
    const authed = t.withIdentity({ subject: `${userId}|session` });

    await t.run(async (ctx) => {
      for (let day = 1; day <= 16; day += 1) {
        await ctx.db.insert("recoveryCheckIns", {
          userId,
          calendarDate: `2026-07-${String(day).padStart(2, "0")}`,
          energy: 3,
          soreness: 3,
          stress: 3,
          createdAt: day,
          updatedAt: day,
        });
      }
    });

    const listed = await authed.query(api.recoveryCheckIns.listRecentMine, {});

    expect(listed).toHaveLength(14);
    expect(listed[0]?.calendarDate).toBe("2026-07-16");
    expect(listed[13]?.calendarDate).toBe("2026-07-03");
  });
});
