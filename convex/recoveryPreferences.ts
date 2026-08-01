import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getEffectiveUserId } from "./lib/auth";
import { rateLimiter } from "./rateLimits";

const recoverySourceValidator = v.union(v.literal("garmin"), v.literal("fitbit"));
const recoveryPreferenceValidator = v.object({
  preferredSource: v.union(recoverySourceValidator, v.null()),
});

type RecoveryPreference = { preferredSource: "garmin" | "fitbit" | null };

export const getMine = query({
  args: {},
  returns: recoveryPreferenceValidator,
  handler: async (ctx): Promise<RecoveryPreference> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) return { preferredSource: null };
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    return { preferredSource: profile?.preferredRecoverySource ?? null };
  },
});

export const setMine = mutation({
  args: { preferredSource: v.union(recoverySourceValidator, v.null()) },
  returns: recoveryPreferenceValidator,
  handler: async (ctx, args): Promise<RecoveryPreference> => {
    const userId = await getEffectiveUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await rateLimiter.limit(ctx, "updateRecoveryPreferences", { key: userId, throws: true });
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .unique();
    if (!profile) throw new Error("User profile not found");
    await ctx.db.patch(profile._id, {
      preferredRecoverySource: args.preferredSource ?? undefined,
    });
    return { preferredSource: args.preferredSource };
  },
});
