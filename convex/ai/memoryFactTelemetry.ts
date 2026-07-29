import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { validateSearchTelemetryWindowMs } from "./searchTelemetry";

const DEFAULT_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;
const QUERY_ROW_LIMIT = 2_000;

const EXERCISE_SELECTION_TOOLS = new Set([
  "search_exercises",
  "create_workout",
  "program_week",
  "rebuild_day",
  "swap_exercise",
  "add_exercise",
  "set_warmup_block",
  "adjust_session_duration",
]);

export interface MemoryFactTelemetryRow {
  userId: string;
  source: "chat" | "approval_continuation";
  finishReason?: string;
  toolSequence: readonly string[];
  memoryFactsInjected?: number;
}

export interface MemoryFactSearchCohort {
  eligibleTurns: number;
  searchExerciseCalls: number;
  turnsWithSearch: number;
  repeatedSearchTurns: number;
  callsPerEligibleTurn: number;
  searchTurnRate: number;
}

export interface MemoryFactSearchTelemetrySummary {
  legacyEligibleTurns: number;
  pairedUsers: number;
  withoutFacts: MemoryFactSearchCohort;
  withFacts: MemoryFactSearchCohort;
  pairedWithoutFacts: MemoryFactSearchCohort;
  pairedWithFacts: MemoryFactSearchCohort;
  absolutePairedCallsPerTurnDelta: number;
  relativePairedCallsPerTurnChange: number | null;
}

interface MutableCohort {
  eligibleTurns: number;
  searchExerciseCalls: number;
  turnsWithSearch: number;
  repeatedSearchTurns: number;
}

function emptyCohort(): MutableCohort {
  return {
    eligibleTurns: 0,
    searchExerciseCalls: 0,
    turnsWithSearch: 0,
    repeatedSearchTurns: 0,
  };
}

function addTurn(cohort: MutableCohort, searchCalls: number): void {
  cohort.eligibleTurns += 1;
  cohort.searchExerciseCalls += searchCalls;
  if (searchCalls > 0) cohort.turnsWithSearch += 1;
  if (searchCalls > 1) cohort.repeatedSearchTurns += 1;
}

function finalizeCohort(cohort: MutableCohort): MemoryFactSearchCohort {
  const denominator = cohort.eligibleTurns;
  return {
    ...cohort,
    callsPerEligibleTurn: denominator === 0 ? 0 : cohort.searchExerciseCalls / denominator,
    searchTurnRate: denominator === 0 ? 0 : cohort.turnsWithSearch / denominator,
  };
}

function isEligibleTurn(row: MemoryFactTelemetryRow): boolean {
  return (
    row.source === "chat" &&
    row.finishReason !== "error" &&
    row.toolSequence.some((toolName) => EXERCISE_SELECTION_TOOLS.has(toolName))
  );
}

export function aggregateMemoryFactSearchTelemetry(
  rows: readonly MemoryFactTelemetryRow[],
): MemoryFactSearchTelemetrySummary {
  const withoutFacts = emptyCohort();
  const withFacts = emptyCohort();
  let legacyEligibleTurns = 0;
  const userStates = new Map<string, Set<"without" | "with">>();

  for (const row of rows) {
    if (!isEligibleTurn(row)) continue;
    if (row.memoryFactsInjected === undefined) {
      legacyEligibleTurns += 1;
      continue;
    }
    const state = row.memoryFactsInjected > 0 ? "with" : "without";
    const searchCalls = row.toolSequence.filter((tool) => tool === "search_exercises").length;
    addTurn(state === "with" ? withFacts : withoutFacts, searchCalls);
    const states = userStates.get(row.userId) ?? new Set<"without" | "with">();
    states.add(state);
    userStates.set(row.userId, states);
  }

  const pairedUserIds = new Set(
    [...userStates.entries()]
      .filter(([, states]) => states.has("without") && states.has("with"))
      .map(([userId]) => userId),
  );
  const pairedWithoutFacts = emptyCohort();
  const pairedWithFacts = emptyCohort();
  for (const row of rows) {
    if (!pairedUserIds.has(row.userId) || !isEligibleTurn(row)) continue;
    if (row.memoryFactsInjected === undefined) continue;
    const searchCalls = row.toolSequence.filter((tool) => tool === "search_exercises").length;
    addTurn(row.memoryFactsInjected > 0 ? pairedWithFacts : pairedWithoutFacts, searchCalls);
  }

  const pairedWithout = finalizeCohort(pairedWithoutFacts);
  const pairedWith = finalizeCohort(pairedWithFacts);
  const absoluteDelta = pairedWith.callsPerEligibleTurn - pairedWithout.callsPerEligibleTurn;

  return {
    legacyEligibleTurns,
    pairedUsers: pairedUserIds.size,
    withoutFacts: finalizeCohort(withoutFacts),
    withFacts: finalizeCohort(withFacts),
    pairedWithoutFacts: pairedWithout,
    pairedWithFacts: pairedWith,
    absolutePairedCallsPerTurnDelta: absoluteDelta,
    relativePairedCallsPerTurnChange:
      pairedWithout.callsPerEligibleTurn === 0
        ? null
        : absoluteDelta / pairedWithout.callsPerEligibleTurn,
  };
}

export const getMemoryFactSearchTelemetry = internalQuery({
  args: {
    environment: v.union(v.literal("dev"), v.literal("prod")),
    windowMs: v.optional(v.number()),
  },
  handler: async (ctx, { environment, windowMs }) => {
    const normalizedWindowMs = validateSearchTelemetryWindowMs(windowMs ?? DEFAULT_WINDOW_MS);
    const until = Date.now();
    const since = until - normalizedWindowMs;
    const rows = await ctx.db
      .query("aiRun")
      .withIndex("by_environment_and_createdAt", (q) =>
        q.eq("environment", environment).gte("createdAt", since).lte("createdAt", until),
      )
      .order("desc")
      .take(QUERY_ROW_LIMIT + 1);
    const truncated = rows.length > QUERY_ROW_LIMIT;
    const analyzedRows = rows.slice(0, QUERY_ROW_LIMIT);

    return {
      environment,
      since,
      until,
      analyzedTurns: analyzedRows.length,
      truncated,
      ...aggregateMemoryFactSearchTelemetry(analyzedRows),
    };
  },
});
