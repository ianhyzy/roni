import { type FunctionReference, getFunctionName } from "convex/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { type EnrichedWeekPlan, getWeekPlanEnriched, safeActivities } from "./weekPlanEnriched";
import type { Activity } from "./tonal/types";

type TestRef = FunctionReference<"query" | "mutation" | "action", "public" | "internal">;
type EnrichedArgs = { userTimezone?: string };

const USER_ID = "user-1" as Id<"users">;

function getHandler<T>(registered: unknown): T {
  return (registered as { _handler: T })._handler;
}

const handler =
  getHandler<(ctx: ActionCtx, args: EnrichedArgs) => Promise<EnrichedWeekPlan | null>>(
    getWeekPlanEnriched,
  );

function createContext() {
  const runQuery = vi.fn(async (ref: TestRef, _args?: Record<string, unknown>) => {
    const name = getFunctionName(ref);
    if (name === "lib/auth:resolveEffectiveUserId") return USER_ID;
    if (name === "weekPlans:getByUserIdAndWeekStartInternal") return null;
    throw new Error(`Unexpected query ${name}`);
  });
  const ctx = { runQuery } as unknown as ActionCtx;
  return { ctx, runQuery };
}

function getQueriedWeekStart(runQuery: ReturnType<typeof createContext>["runQuery"]): string {
  const call = runQuery.mock.calls.find(
    ([ref]) => getFunctionName(ref) === "weekPlans:getByUserIdAndWeekStartInternal",
  );
  if (!call) throw new Error("Week plan query was not called");
  return (call[1] as { weekStartDate: string }).weekStartDate;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("safeActivities", () => {
  it("returns activities on success", async () => {
    const mockActivities: Activity[] = [
      {
        activityId: "a1",
        activityTime: "2026-04-01T10:00:00Z",
        workoutPreview: { workoutId: "w1", workoutTitle: "Push Day" },
      } as Activity,
    ];
    const fetcher = async () => mockActivities;
    const result = await safeActivities(fetcher);
    expect(result).toEqual(mockActivities);
  });

  it("returns empty array and logs when fetcher throws", async () => {
    const fetcher = async (): Promise<Activity[]> => {
      throw new Error("Tonal API 500: Internal Server Error");
    };
    const result = await safeActivities(fetcher);
    expect(result).toEqual([]);
  });
});

describe("getWeekPlanEnriched timezone week selection", () => {
  it("uses the prior Monday while Los Angeles is still on Sunday", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T00:30:00.000Z"));
    const { ctx, runQuery } = createContext();

    await handler(ctx, { userTimezone: "  America/Los_Angeles  " });

    expect(getQueriedWeekStart(runQuery)).toBe("2026-03-02");
  });

  it.each([
    { label: "invalid", args: { userTimezone: "Not/A/Timezone" } },
    { label: "missing", args: {} },
  ] satisfies { label: string; args: EnrichedArgs }[])(
    "uses the UTC Monday for an $label timezone",
    async ({ args }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-09T00:30:00.000Z"));
      const { ctx, runQuery } = createContext();

      await handler(ctx, args);

      expect(getQueriedWeekStart(runQuery)).toBe("2026-03-09");
    },
  );
});
