import { estimateModelRequestCostUsd } from "./modelPricing";
import { type ProviderId, resolvePricingProviderId } from "./providers";

export const CIRCUIT_BREAKER_WINDOW_MS = 60_000;
export const CIRCUIT_BREAKER_OPEN_MS = 5 * 60_000;
export const HALF_OPEN_PROBE_TIMEOUT_MS = 5 * 60_000;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;
const CIRCUIT_BREAKER_FAILED_COST_THRESHOLD_USD = 1;

export type CircuitBreakerState = "closed" | "open" | "half_open";
export type BreakerOpenReason = "error_threshold" | "cost_threshold" | "half_open_failure";
export type BreakerRouteReason = "closed" | "open_circuit" | "half_open_probe" | "half_open_busy";

export interface StoredCircuitBreakerState {
  provider: ProviderId;
  state: CircuitBreakerState;
  openUntil?: number;
  probeRunId?: string;
  probeClaimedAt?: number;
  lastStateChangedAt: number;
  lastOpenReason?: BreakerOpenReason;
  lastOpenFailureCount?: number;
  lastOpenFailedCostUsd?: number;
}

export interface AttemptCostInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface BreakerWindowMetrics {
  recentFailures: number;
  recentFailedCostUsd: number;
}

export interface CircuitRouteDecision {
  route: "primary" | "fallback";
  reason: BreakerRouteReason;
  nextState: StoredCircuitBreakerState | null;
}

export interface HalfOpenProbeResolution {
  didChange: boolean;
  eventReason: "probe_success" | "half_open_failure" | null;
  nextState: StoredCircuitBreakerState;
}

export function estimateAttemptCostUsd(input: AttemptCostInput): number {
  return estimateModelRequestCostUsd({
    provider: resolvePricingProviderId(input.provider),
    requestedModelId: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
  });
}

export function evaluateBreakerOpenReason(metrics: BreakerWindowMetrics): BreakerOpenReason | null {
  if (metrics.recentFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    return "error_threshold";
  }
  if (metrics.recentFailedCostUsd > CIRCUIT_BREAKER_FAILED_COST_THRESHOLD_USD) {
    return "cost_threshold";
  }
  return null;
}

export function decideCircuitRoute(args: {
  state?: StoredCircuitBreakerState;
  now: number;
  runId: string;
}): CircuitRouteDecision {
  const { state, now, runId } = args;
  if (!state || state.state === "closed") {
    return { route: "primary", reason: "closed", nextState: null };
  }

  if (state.state === "open") {
    if (state.openUntil !== undefined && state.openUntil > now) {
      return { route: "fallback", reason: "open_circuit", nextState: null };
    }

    return {
      route: "primary",
      reason: "half_open_probe",
      nextState: {
        ...state,
        state: "half_open",
        openUntil: undefined,
        probeRunId: runId,
        probeClaimedAt: now,
        lastStateChangedAt: now,
      },
    };
  }

  const probeClaimExpired =
    state.probeClaimedAt !== undefined && state.probeClaimedAt + HALF_OPEN_PROBE_TIMEOUT_MS <= now;

  if (state.probeRunId && state.probeRunId !== runId && !probeClaimExpired) {
    return { route: "fallback", reason: "half_open_busy", nextState: null };
  }

  if (state.probeRunId === runId && !probeClaimExpired) {
    return { route: "primary", reason: "half_open_probe", nextState: null };
  }

  return {
    route: "primary",
    reason: "half_open_probe",
    nextState: {
      ...state,
      probeRunId: runId,
      probeClaimedAt: now,
      lastStateChangedAt: now,
    },
  };
}

export function resolveHalfOpenProbeResult(args: {
  state: StoredCircuitBreakerState;
  now: number;
  runId: string;
  outcome: "success" | "failure";
}): HalfOpenProbeResolution {
  const { state, now, runId, outcome } = args;
  if (state.state !== "half_open" || state.probeRunId !== runId) {
    return { didChange: false, eventReason: null, nextState: state };
  }

  if (outcome === "success") {
    return {
      didChange: true,
      eventReason: "probe_success",
      nextState: {
        ...state,
        state: "closed",
        openUntil: undefined,
        probeRunId: undefined,
        probeClaimedAt: undefined,
        lastStateChangedAt: now,
      },
    };
  }

  return {
    didChange: true,
    eventReason: "half_open_failure",
    nextState: {
      ...state,
      state: "open",
      openUntil: now + CIRCUIT_BREAKER_OPEN_MS,
      probeRunId: undefined,
      probeClaimedAt: undefined,
      lastStateChangedAt: now,
      lastOpenReason: "half_open_failure",
    },
  };
}
