import type { StepResult, ToolSet } from "ai";

export type TelemetryFinishReason =
  "stop" | "tool-calls" | "length" | "content-filter" | "error" | "other" | "unknown";

export function normalizeFinishReason(
  raw: StepResult<ToolSet>["finishReason"],
): TelemetryFinishReason {
  switch (raw) {
    case "stop":
    case "tool-calls":
    case "length":
    case "content-filter":
    case "error":
    case "other":
      return raw;
    default:
      return "other";
  }
}
