import { getFunctionName } from "convex/server";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { COACH_TOOLS } from "./coachTools";
import { makeCoachAgentConfig } from "./coach";

type ToolContext = {
  userId: string;
  runQuery: (...args: unknown[]) => Promise<unknown>;
  runMutation: (...args: unknown[]) => Promise<unknown>;
  runAction: (...args: unknown[]) => Promise<unknown>;
};

type ExecutableTool = {
  execute: (
    input: unknown,
    options: { toolCallId: string; messages: ModelMessage[] },
  ) => Promise<unknown>;
};

const LOCAL_WEEK_START = "2026-07-27";
const UTC_WEEK_START = "2026-08-03";
const WEEK_QUERY_NAME = getFunctionName(internal.weekPlans.getByUserIdAndWeekStartInternal);
const SNAPSHOT_QUERY_NAME = getFunctionName(internal.coachState.gatherSnapshotInputs);

const CURRENT_WEEK_TOOL_CASES = [
  { name: "get_week_plan_details", input: {} },
  { name: "get_weekly_volume", input: {} },
  { name: "delete_week_plan", input: {} },
  { name: "approve_week_plan", input: {} },
  {
    name: "swap_exercise",
    input: { dayIndex: 0, oldMovementId: "old", newMovementId: "new" },
  },
  { name: "add_exercise", input: { dayIndex: 0, movementId: "new", sets: 3, reps: 8 } },
  {
    name: "set_warmup_block",
    input: { dayIndex: 0, exercises: [{ movementId: "warmup", sets: 1, reps: 8 }] },
  },
  { name: "move_session", input: { fromDayIndex: 0, toDayIndex: 1 } },
  { name: "adjust_session_duration", input: { dayIndex: 0, newDurationMinutes: "45" } },
  { name: "rebuild_day", input: { dayIndex: 0, blocks: [{ exercises: [{ name: "Press" }] }] } },
] as const;

async function executeTool(tool: unknown, input: unknown, ctx: ToolContext) {
  const executable = { ...(tool as object), ctx } as unknown as ExecutableTool;
  return await executable.execute(input, { toolCallId: "timezone-test", messages: [] });
}

function emptySnapshotInputs() {
  return {
    profile: {
      profileData: {
        firstName: "Time",
        lastName: "Zone",
        heightInches: 70,
        weightPounds: 180,
        level: "intermediate",
        workoutsPerWeek: 3,
      },
    },
    scores: [],
    readiness: null,
    activities: [
      {
        date: "2026-07-26",
        title: "Previous workout",
        targetArea: "Upper",
        totalVolume: 1000,
        totalDuration: 1800,
        tonalWorkoutId: "tonal-other",
      },
    ],
    activeBlock: null,
    recentFeedback: [],
    activeGoals: [],
    activeInjuries: [],
    exerciseExclusions: [],
    externalActivities: [],
    garminWellness: [],
    fitbitWellness: [],
    memoryFacts: [],
  };
}

afterEach(() => vi.useRealTimers());

describe("current-week timezone binding", () => {
  it.each(CURRENT_WEEK_TOOL_CASES)("uses one local week for $name", async ({ name, input }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T01:00:00.000Z"));
    const runQuery = vi.fn(async (_ref: unknown, _args: unknown) => null);
    const tools = makeCoachAgentConfig({
      userTimezone: " America/Los_Angeles ",
    }).tools;

    await executeTool(tools[name], input, {
      userId: "user-1",
      runQuery,
      runMutation: vi.fn(async () => null),
      runAction: vi.fn(async () => null),
    });

    expect(runQuery.mock.calls[0][1]).toEqual({
      userId: "user-1",
      weekStartDate: LOCAL_WEEK_START,
    });
  });

  it("uses the same local week for program_week", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T01:00:00.000Z"));
    const runAction = vi.fn(async (_ref: unknown, _args: unknown) => ({
      success: false,
      error: "stop after capture",
    }));
    const tool = makeCoachAgentConfig({
      userTimezone: " America/Los_Angeles ",
    }).tools.program_week;

    await executeTool(
      tool,
      {},
      {
        userId: "user-1",
        runQuery: vi.fn(async () => null),
        runMutation: vi.fn(async () => null),
        runAction,
      },
    );

    expect(runAction.mock.calls[0][1]).toMatchObject({
      userId: "user-1",
      weekStartDate: LOCAL_WEEK_START,
    });
  });

  it("keeps default tool exports on UTC and safely falls back for invalid timezones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T01:00:00.000Z"));
    const runDefaultQuery = vi.fn(async (_ref: unknown, _args: unknown) => null);
    const runInvalidQuery = vi.fn(async (_ref: unknown, _args: unknown) => null);
    const makeContext = (runQuery: typeof runDefaultQuery): ToolContext => ({
      userId: "user-1",
      runQuery,
      runMutation: vi.fn(async () => null),
      runAction: vi.fn(async () => null),
    });

    await executeTool(COACH_TOOLS.get_week_plan_details, {}, makeContext(runDefaultQuery));
    await executeTool(
      makeCoachAgentConfig({ userTimezone: "Not/A_Timezone" }).tools.get_week_plan_details,
      {},
      makeContext(runInvalidQuery),
    );

    expect(runDefaultQuery.mock.calls[0][1]).toMatchObject({ weekStartDate: UTC_WEEK_START });
    expect(runInvalidQuery.mock.calls[0][1]).toMatchObject({ weekStartDate: UTC_WEEK_START });
  });

  it("uses the local week, date, and weekday index in snapshot context", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T01:00:00.000Z"));
    const weekQueries: unknown[] = [];
    const ctx = {
      runQuery: vi.fn(async (ref: unknown, args: unknown) => {
        const name = getFunctionName(ref as never);
        if (name === SNAPSHOT_QUERY_NAME) return emptySnapshotInputs();
        if (name === WEEK_QUERY_NAME) {
          weekQueries.push(args);
          return {
            days: [
              {
                sessionType: "push",
                status: "programmed",
                workoutPlanId: "plan-monday",
              },
              ...Array.from({ length: 6 }, () => ({
                sessionType: "rest",
                status: "programmed",
              })),
            ],
          };
        }
        return { tonalWorkoutId: "tonal-plan" };
      }),
    };
    const contextHandler = makeCoachAgentConfig({
      userTimezone: " America/Los_Angeles ",
    }).contextHandler!;

    const messages = await contextHandler(ctx as never, {
      allMessages: [{ role: "user", content: "How is this week going?" }],
      search: [],
      recent: [],
      inputMessages: [],
      inputPrompt: [],
      existingResponses: [],
      userId: "user-1",
      threadId: undefined,
    });

    expect(weekQueries).toEqual([{ userId: "user-1", weekStartDate: LOCAL_WEEK_START }]);
    const systemText = messages
      .filter((message) => message.role === "system" && typeof message.content === "string")
      .map((message) => message.content)
      .join("\n");
    expect(systemText).toContain("No workouts in 7 days");
    expect(systemText).toContain("Missed: Push Day (Monday)");
  });
});
