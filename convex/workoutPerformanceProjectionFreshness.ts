import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/** Advance only after the matching Tonal source snapshot persists successfully. */
export const markProjectionSourceVerified = internalMutation({
  args: { userId: v.id("users"), sourceFetchedAt: v.number() },
  handler: async (ctx, { userId, sourceFetchedAt }) => {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!profile || (profile.workoutProjectionSourceFetchedAt ?? 0) >= sourceFetchedAt) return;
    await ctx.db.patch(profile._id, { workoutProjectionSourceFetchedAt: sourceFetchedAt });
  },
});
