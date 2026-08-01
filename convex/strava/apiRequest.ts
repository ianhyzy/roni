import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { fetchStravaWithTokenRetry, type StravaAuthorizedFetchResult } from "./client";
import { parseStravaRateLimitHeaders } from "./rateLimitBudget";

const FETCH_TIMEOUT_MS = 15_000;
export const STRAVA_BUDGET_DENIED_HEADER = "X-Roni-Strava-Budget";

export type StravaRequestIdentity = {
  userId: Id<"users">;
  generation: string;
};

function syntheticBudgetResponse(retryAfterMs: number): Response {
  return new Response(null, {
    status: 429,
    headers: {
      "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1_000))),
      [STRAVA_BUDGET_DENIED_HEADER]: "exhausted",
    },
  });
}

export async function requestStravaApi(
  ctx: ActionCtx,
  args: { identity: StravaRequestIdentity; url: URL },
): Promise<StravaAuthorizedFetchResult> {
  return fetchStravaWithTokenRetry(ctx, {
    userId: args.identity.userId,
    generation: args.identity.generation,
    request: async (accessToken) => {
      const reserved = await ctx.runMutation(internal.strava.rateLimitBudget.reserveRequest, {
        now: Date.now(),
      });
      if (!reserved.allowed) return syntheticBudgetResponse(reserved.retryAfterMs);
      try {
        const response = await fetch(args.url, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const observed = parseStravaRateLimitHeaders(response.headers);
        if (observed) {
          await ctx.runMutation(internal.strava.rateLimitBudget.recordResponseHeaders, {
            now: Date.now(),
            observed,
          });
        } else {
          await ctx.runMutation(internal.strava.rateLimitBudget.markResponseUnknown, {
            now: Date.now(),
          });
        }
        return response;
      } catch (error) {
        await ctx.runMutation(internal.strava.rateLimitBudget.markTransportFailure, {
          now: Date.now(),
        });
        throw error;
      }
    },
  });
}
