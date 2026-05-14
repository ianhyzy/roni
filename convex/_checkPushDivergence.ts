// One-off diagnostic query — delete after use (see PR #308 follow-up).
// Run via Convex dashboard or `npx convex run _checkPushDivergence:recentPushDivergences`
// to find aiRun rows with non-null pushDivergence since 2026-04-30.
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

/** Returns aiRun rows with non-null pushDivergence created after `since` (ms epoch). */
export const recentPushDivergences = internalQuery({
  args: { since: v.optional(v.number()) },
  handler: async (ctx, { since }) => {
    const cutoff = since ?? new Date("2026-04-30T00:00:00Z").getTime();
    const rows = await ctx.db
      .query("aiRun")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", cutoff))
      .filter((q) => q.neq(q.field("pushDivergence"), undefined))
      .take(100);

    return rows.map((r) => ({
      _id: r._id,
      createdAt: new Date(r.createdAt).toISOString(),
      userId: r.userId,
      pushDivergence: r.pushDivergence,
      workoutPushOutcome: r.workoutPushOutcome,
    }));
  },
});
