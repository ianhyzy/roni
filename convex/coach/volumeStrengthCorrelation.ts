export const WINDOW_WEEKS = 26 as const;
export const MIN_PAIRED_OBSERVATIONS = 8;
export const PROGRAMMING_MIN_PAIRED_OBSERVATIONS = 16;
export const PROGRAMMING_MAX_RECENCY_DAYS = 28;
const FLAT_CORRELATION_THRESHOLD = 0.2;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export const REGIONS = ["upper", "lower", "core"] as const;

export type Region = (typeof REGIONS)[number];
export type CorrelationDirection = "positive" | "negative" | "flat";
export type CorrelationConfidence = "low" | "medium";
export type ProgrammingEligibilityReason =
  "low_confidence" | "stale_observations" | "unmapped_movements" | "no_negative_relationship";

export type ProgrammingEligibility =
  | {
      status: "advisory_only";
      reasons: readonly ProgrammingEligibilityReason[];
    }
  | {
      status: "eligible_for_mrv_estimation";
      reasons: readonly [];
    };

interface RegionObservationCounts {
  region: Region;
  weeklyObservationCount: number;
  strengthObservationCount: number;
  unmappedMovementCount: number;
}

export interface InsufficientRegionResult extends RegionObservationCounts {
  status: "insufficient_data";
}

export interface ProvisionalRegionResult extends RegionObservationCounts {
  status: "provisional";
  pairedObservationCount: number;
  latestPairedWeek: string;
  daysSinceLatestPairedWeek: number;
  spearmanRho: number;
  direction: CorrelationDirection;
  confidence: CorrelationConfidence;
  programmingEligibility: ProgrammingEligibility;
  volumeRange: {
    minWeeklyVolume: number;
    maxWeeklyVolume: number;
  };
}

export type RegionResult = InsufficientRegionResult | ProvisionalRegionResult;

export interface VolumeStrengthAnalysis {
  windowWeeks: typeof WINDOW_WEEKS;
  regions: readonly RegionResult[];
  caveat: string;
}

export interface VolumePerformanceRow {
  movementId: string;
  date: string;
  totalVolume?: number;
}

export interface RegionalStrengthSnapshot {
  date: string;
  upper: number;
  lower: number;
  core: number;
}

export interface MovementRegionMetadata {
  tonalId: string;
  bodyRegion?: string;
  muscleGroups: readonly string[];
}

export interface VolumeStrengthAnalysisInput {
  windowStartDate: string;
  windowEndDate: string;
  performanceRows: readonly VolumePerformanceRow[];
  strengthSnapshots: readonly RegionalStrengthSnapshot[];
  movements: readonly MovementRegionMetadata[];
}

const ANALYSIS_CAVEAT =
  "This is an observational correlation, not causal MRV, and must not be used as a hard cap on training volume. Weeks with missing or unmapped volume data are excluded.";
const DATA_LIMIT_CAVEAT = `${ANALYSIS_CAVEAT} A bounded data limit exceeded, so no provisional correlation was calculated.`;

const MUSCLE_REGION: Readonly<Record<string, Region>> = {
  chest: "upper",
  shoulders: "upper",
  back: "upper",
  triceps: "upper",
  biceps: "upper",
  forearms: "upper",
  quads: "lower",
  quadriceps: "lower",
  glutes: "lower",
  hamstrings: "lower",
  calves: "lower",
  core: "core",
  abs: "core",
  abdominals: "core",
  obliques: "core",
};

type WeeklyVolumeByRegion = Record<Region, Map<string, number>>;
type WeeklyStrengthChangeByRegion = Record<Region, Map<string, number>>;
type IncompleteWeeksByRegion = Record<Region, Set<string>>;

function startOfUtcWeek(date: string): string | null {
  const isoDate = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const parsed = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== isoDate) return null;
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  parsed.setUTCDate(parsed.getUTCDate() - daysSinceMonday);
  return parsed.toISOString().slice(0, 10);
}

function movementRegion(movement: MovementRegionMetadata | undefined): Region | null {
  if (!movement) return null;
  const bodyRegion = movement.bodyRegion?.trim().toLowerCase();
  const explicitRegion = REGIONS.find((region) => bodyRegion?.startsWith(region));
  if (explicitRegion) return explicitRegion;

  const regions = new Set(
    movement.muscleGroups
      .map((muscleGroup) => MUSCLE_REGION[muscleGroup.trim().toLowerCase()])
      .filter((region): region is Region => region !== undefined),
  );
  return regions.size === 1 ? (regions.values().next().value ?? null) : null;
}

function addUtcDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function aggregateWeeklyVolumes(input: VolumeStrengthAnalysisInput): {
  weeklyVolume: WeeklyVolumeByRegion;
  incompleteWeeks: IncompleteWeeksByRegion;
  unmappedMovementCount: number;
} {
  const movementById = new Map(input.movements.map((movement) => [movement.tonalId, movement]));
  const weeklyVolume: WeeklyVolumeByRegion = {
    upper: new Map(),
    lower: new Map(),
    core: new Map(),
  };
  const unmappedMovementIds = new Set<string>();
  const incompleteWeeks: IncompleteWeeksByRegion = {
    upper: new Set(),
    lower: new Set(),
    core: new Set(),
  };

  for (const row of input.performanceRows) {
    const date = row.date.slice(0, 10);
    if (date < input.windowStartDate || date > input.windowEndDate) continue;
    const week = startOfUtcWeek(row.date);
    if (!week) continue;
    const region = movementRegion(movementById.get(row.movementId));
    if (!region) {
      unmappedMovementIds.add(row.movementId);
      for (const affectedRegion of REGIONS) incompleteWeeks[affectedRegion].add(week);
      continue;
    }
    if (row.totalVolume === undefined || !Number.isFinite(row.totalVolume) || row.totalVolume < 0) {
      incompleteWeeks[region].add(week);
      continue;
    }
    weeklyVolume[region].set(week, (weeklyVolume[region].get(week) ?? 0) + row.totalVolume);
  }

  return { weeklyVolume, incompleteWeeks, unmappedMovementCount: unmappedMovementIds.size };
}

function aggregateWeeklyStrengthChanges(
  input: VolumeStrengthAnalysisInput,
): WeeklyStrengthChangeByRegion {
  const weeklyLatest: Record<Region, Map<string, { date: string; score: number }>> = {
    upper: new Map(),
    lower: new Map(),
    core: new Map(),
  };

  for (const snapshot of input.strengthSnapshots) {
    const date = snapshot.date.slice(0, 10);
    if (date > input.windowEndDate) continue;
    const week = startOfUtcWeek(date);
    if (!week) continue;
    for (const region of REGIONS) {
      const score = snapshot[region];
      if (!Number.isFinite(score)) continue;
      const previous = weeklyLatest[region].get(week);
      if (!previous || date > previous.date) weeklyLatest[region].set(week, { date, score });
    }
  }

  const windowStartWeek = startOfUtcWeek(input.windowStartDate) ?? input.windowStartDate;
  const windowEndWeek = startOfUtcWeek(input.windowEndDate) ?? input.windowEndDate;
  const changes: WeeklyStrengthChangeByRegion = {
    upper: new Map(),
    lower: new Map(),
    core: new Map(),
  };
  for (const region of REGIONS) {
    for (const [week, latest] of weeklyLatest[region]) {
      if (week < windowStartWeek || week > windowEndWeek) continue;
      const previous = weeklyLatest[region].get(addUtcDays(week, -7));
      if (previous) changes[region].set(week, latest.score - previous.score);
    }
  }
  return changes;
}

function averageRanks(values: readonly number[]): number[] {
  const sorted = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = Array<number>(values.length);
  let start = 0;
  while (start < sorted.length) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
    const averageRank = (start + 1 + end) / 2;
    for (let index = start; index < end; index++) ranks[sorted[index].index] = averageRank;
    start = end;
  }
  return ranks;
}

function spearmanRho(pairs: readonly { volume: number; strengthChange: number }[]): number | null {
  const volumeRanks = averageRanks(pairs.map((pair) => pair.volume));
  const strengthRanks = averageRanks(pairs.map((pair) => pair.strengthChange));
  const meanRank = (pairs.length + 1) / 2;
  let covariance = 0;
  let volumeVariance = 0;
  let strengthVariance = 0;
  for (let index = 0; index < pairs.length; index++) {
    const volumeDelta = volumeRanks[index] - meanRank;
    const strengthDelta = strengthRanks[index] - meanRank;
    covariance += volumeDelta * strengthDelta;
    volumeVariance += volumeDelta * volumeDelta;
    strengthVariance += strengthDelta * strengthDelta;
  }
  if (volumeVariance === 0 || strengthVariance === 0) return null;
  return covariance / Math.sqrt(volumeVariance * strengthVariance);
}

function directionFor(rho: number): CorrelationDirection {
  if (rho >= FLAT_CORRELATION_THRESHOLD) return "positive";
  if (rho <= -FLAT_CORRELATION_THRESHOLD) return "negative";
  return "flat";
}

function daysBetweenUtcDates(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor((end - start) / MILLISECONDS_PER_DAY));
}

function assessProgrammingEligibility({
  confidence,
  daysSinceLatestPairedWeek,
  direction,
  unmappedMovementCount,
}: {
  confidence: CorrelationConfidence;
  daysSinceLatestPairedWeek: number;
  direction: CorrelationDirection;
  unmappedMovementCount: number;
}): ProgrammingEligibility {
  const reasons: ProgrammingEligibilityReason[] = [];
  if (confidence !== "medium") reasons.push("low_confidence");
  if (daysSinceLatestPairedWeek > PROGRAMMING_MAX_RECENCY_DAYS) {
    reasons.push("stale_observations");
  }
  if (unmappedMovementCount > 0) reasons.push("unmapped_movements");
  if (direction !== "negative") reasons.push("no_negative_relationship");
  return reasons.length === 0
    ? { status: "eligible_for_mrv_estimation", reasons: [] }
    : { status: "advisory_only", reasons };
}

function buildRegionResult({
  region,
  weeklyVolume,
  weeklyStrengthChange,
  unmappedMovementCount,
  inputWindowEndDate,
}: {
  region: Region;
  weeklyVolume: WeeklyVolumeByRegion;
  weeklyStrengthChange: WeeklyStrengthChangeByRegion;
  unmappedMovementCount: number;
  inputWindowEndDate: string;
}): RegionResult {
  const counts = {
    region,
    weeklyObservationCount: weeklyVolume[region].size,
    strengthObservationCount: weeklyStrengthChange[region].size,
    unmappedMovementCount,
  };
  const pairs = [...weeklyVolume[region]]
    .filter(([week]) => weeklyStrengthChange[region].has(week))
    .sort(([weekA], [weekB]) => weekA.localeCompare(weekB))
    .map(([week, volume]) => ({
      week,
      volume,
      strengthChange: weeklyStrengthChange[region].get(week) ?? 0,
    }));
  if (pairs.length < MIN_PAIRED_OBSERVATIONS) return { status: "insufficient_data", ...counts };
  const rawRho = spearmanRho(pairs);
  if (rawRho === null) return { status: "insufficient_data", ...counts };
  const volumes = pairs.map((pair) => pair.volume);
  const spearmanRhoRounded = Math.round(Math.max(-1, Math.min(1, rawRho)) * 1000) / 1000;
  const direction = directionFor(spearmanRhoRounded);
  const confidence = pairs.length >= PROGRAMMING_MIN_PAIRED_OBSERVATIONS ? "medium" : "low";
  const latestPairedWeek = pairs.at(-1)?.week;
  if (!latestPairedWeek) return { status: "insufficient_data", ...counts };
  const daysSinceLatestPairedWeek = daysBetweenUtcDates(latestPairedWeek, inputWindowEndDate);
  return {
    status: "provisional",
    ...counts,
    pairedObservationCount: pairs.length,
    latestPairedWeek,
    daysSinceLatestPairedWeek,
    spearmanRho: spearmanRhoRounded,
    direction,
    confidence,
    programmingEligibility: assessProgrammingEligibility({
      confidence,
      daysSinceLatestPairedWeek,
      direction,
      unmappedMovementCount,
    }),
    volumeRange: {
      minWeeklyVolume: Math.min(...volumes),
      maxWeeklyVolume: Math.max(...volumes),
    },
  };
}

export function analyzeVolumeStrength(input: VolumeStrengthAnalysisInput): VolumeStrengthAnalysis {
  const { weeklyVolume, incompleteWeeks, unmappedMovementCount } = aggregateWeeklyVolumes(input);
  const weeklyStrengthChange = aggregateWeeklyStrengthChanges(input);
  for (const region of REGIONS) {
    for (const week of incompleteWeeks[region]) weeklyVolume[region].delete(week);
    for (const week of weeklyStrengthChange[region].keys()) {
      if (!incompleteWeeks[region].has(week) && !weeklyVolume[region].has(week)) {
        weeklyVolume[region].set(week, 0);
      }
    }
  }
  return {
    windowWeeks: WINDOW_WEEKS,
    regions: REGIONS.map((region) =>
      buildRegionResult({
        region,
        weeklyVolume,
        weeklyStrengthChange,
        unmappedMovementCount,
        inputWindowEndDate: input.windowEndDate,
      }),
    ),
    caveat: ANALYSIS_CAVEAT,
  };
}

export function buildDataLimitExceededAnalysis(): VolumeStrengthAnalysis {
  return {
    windowWeeks: WINDOW_WEEKS,
    regions: REGIONS.map((region) => ({
      status: "insufficient_data",
      region,
      weeklyObservationCount: 0,
      strengthObservationCount: 0,
      unmappedMovementCount: 0,
    })),
    caveat: DATA_LIMIT_CAVEAT,
  };
}
