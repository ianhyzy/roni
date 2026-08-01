import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { getEffectiveUserId } from "./lib/auth";
import { rateLimiter } from "./rateLimits";

const MAX_RECENT_CHECK_INS = 14;
const MAX_NOTES_LENGTH = 500;
const DAY_MS = 24 * 60 * 60 * 1_000;

const recoveryCheckInViewValidator = v.object({
  calendarDate: v.string(),
  energy: v.number(),
  soreness: v.number(),
  stress: v.number(),
  notes: v.union(v.string(), v.null()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

type RecoveryCheckInView = {
  calendarDate: string;
  energy: number;
  soreness: number;
  stress: number;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
};

function toView(row: Doc<"recoveryCheckIns">): RecoveryCheckInView {
  return {
    calendarDate: row.calendarDate,
    energy: row.energy,
    soreness: row.soreness,
    stress: row.stress,
    notes: row.notes ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertValidCalendarDate(calendarDate: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calendarDate);
  if (!match) throw new Error("calendarDate must be a valid YYYY-MM-DD date");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error("calendarDate must be a valid YYYY-MM-DD date");
  }
  const now = new Date(Date.now());
  const tomorrowUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS;
  if (parsed.getTime() > tomorrowUtc) {
    throw new Error("calendarDate cannot be more than one UTC day in the future");
  }
}

function assertScore(name: "energy" | "soreness" | "stress", value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${name} must be an integer from 1 to 5`);
  }
}

export const listRecentMine = query({
  args: {},
  returns: v.array(recoveryCheckInViewValidator),
  handler: async (ctx): Promise<RecoveryCheckInView[]> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return [];
    const rows = await ctx.db
      .query("recoveryCheckIns")
      .withIndex("by_userId_and_updatedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_RECENT_CHECK_INS);
    return rows.map(toView);
  },
});

export const upsertMine = mutation({
  args: {
    calendarDate: v.string(),
    energy: v.number(),
    soreness: v.number(),
    stress: v.number(),
    notes: v.optional(v.string()),
  },
  returns: recoveryCheckInViewValidator,
  handler: async (ctx, args): Promise<RecoveryCheckInView> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await rateLimiter.limit(ctx, "saveRecoveryCheckIn", { key: userId, throws: true });

    assertValidCalendarDate(args.calendarDate);
    assertScore("energy", args.energy);
    assertScore("soreness", args.soreness);
    assertScore("stress", args.stress);
    const notes = args.notes?.trim();
    if (notes && notes.length > MAX_NOTES_LENGTH) {
      throw new Error(`notes must be ${MAX_NOTES_LENGTH} characters or fewer`);
    }

    const existing = await ctx.db
      .query("recoveryCheckIns")
      .withIndex("by_userId_and_calendarDate", (q) =>
        q.eq("userId", userId).eq("calendarDate", args.calendarDate),
      )
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        energy: args.energy,
        soreness: args.soreness,
        stress: args.stress,
        notes: notes || undefined,
        updatedAt: now,
      });
      return toView({
        ...existing,
        energy: args.energy,
        soreness: args.soreness,
        stress: args.stress,
        notes: notes || undefined,
        updatedAt: now,
      });
    }

    const recoveryCheckIn = {
      userId,
      calendarDate: args.calendarDate,
      energy: args.energy,
      soreness: args.soreness,
      stress: args.stress,
      ...(notes ? { notes } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const recoveryCheckInId = await ctx.db.insert("recoveryCheckIns", recoveryCheckIn);
    return toView({
      _id: recoveryCheckInId,
      _creationTime: now,
      ...recoveryCheckIn,
    });
  },
});
