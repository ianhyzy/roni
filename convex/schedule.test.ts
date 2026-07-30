import { type FunctionReference, getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { getScheduleData, type ScheduleData } from "./schedule";

type TestRef = FunctionReference<"query" | "action", "public" | "internal">;
type ScheduleArgs = { userTimezone?: string };

const USER_ID = "user-1" as Id<"users">;

function getHandler<T>(registered: unknown): T {
  return (registered as { _handler: T })._handler;
}

const handler =
  getHandler<(ctx: ActionCtx, args: ScheduleArgs) => Promise<ScheduleData | null>>(getScheduleData);

function createContext(userId: Id<"users"> | null) {
  const runQuery = vi.fn(async (ref: TestRef) => {
    expect(getFunctionName(ref)).toBe("lib/auth:resolveEffectiveUserId");
    return userId;
  });
  const runAction = vi.fn(async (_ref: TestRef, _args?: Record<string, unknown>) => null);
  const ctx = { runQuery, runAction } as unknown as ActionCtx;
  return { ctx, runAction };
}

describe("getScheduleData timezone forwarding", () => {
  it("sanitizes a padded timezone before loading the enriched week", async () => {
    const { ctx, runAction } = createContext(USER_ID);

    await handler(ctx, { userTimezone: "  America/Los_Angeles  " });

    expect(runAction).toHaveBeenCalledTimes(1);
    expect(getFunctionName(runAction.mock.calls[0][0] as TestRef)).toBe(
      "weekPlanEnriched:getWeekPlanEnriched",
    );
    expect(runAction.mock.calls[0][1]).toEqual({ userTimezone: "America/Los_Angeles" });
  });

  it.each([
    { label: "invalid", args: { userTimezone: "Not/A/Timezone" } },
    { label: "missing", args: {} },
  ] satisfies { label: string; args: ScheduleArgs }[])(
    "omits an $label timezone from the nested action",
    async ({ args }) => {
      const { ctx, runAction } = createContext(USER_ID);

      await handler(ctx, args);

      expect(runAction.mock.calls[0][1]).toEqual({});
    },
  );

  it("rejects unauthenticated callers before loading the enriched week", async () => {
    const { ctx, runAction } = createContext(null);

    await expect(handler(ctx, { userTimezone: "America/Los_Angeles" })).rejects.toThrow(
      "Not authenticated",
    );
    expect(runAction).not.toHaveBeenCalled();
  });
});
