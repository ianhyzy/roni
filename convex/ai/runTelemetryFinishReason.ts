import type { StepResult, ToolSet } from "ai";

export type TelemetryFinishReason =
  "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other" | "unknown";

const ALLOWED_FINISH_REASONS = new Set<TelemetryFinishReason>([
  "stop",
  "tool-calls",
  "length",
  "content-filter",
  "error",
  "other",
  "unknown",
]);

export function normalizeFinishReason(
  raw: StepResult<ToolSet>["finishReason"],
): TelemetryFinishReason {
  return ALLOWED_FINISH_REASONS.has(raw as TelemetryFinishReason)
    ? (raw as TelemetryFinishReason)
    : "other";
}
