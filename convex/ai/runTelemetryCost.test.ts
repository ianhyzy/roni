import { describe, expect, it } from "vitest";
import { createModelStep } from "./modelStepTestUtils";
import { RunAccumulator } from "./runTelemetry";
import type { Id } from "../_generated/dataModel";

const USER_ID = "k5762r1m174t2cmjgb9178ptk582y3p6" as Id<"users">;

function createAccumulator(): RunAccumulator {
  return new RunAccumulator({
    runId: "run-1",
    userId: USER_ID,
    threadId: "thread-1",
    source: "chat",
    environment: "dev",
    pricingProvider: "openai",
    startedAt: 0,
  });
}

describe("RunAccumulator attempt cost", () => {
  it("records the response model when routing changes the requested model", () => {
    const accumulator = createAccumulator();

    accumulator.onStepFinish(
      createModelStep({
        inputTokens: 300_000,
        outputTokens: 10_000,
        provider: "openai.responses",
        modelId: "gpt-5.4-mini",
        responseModelId: "gpt-5.6-sol",
        billingClass: "cache_write",
      }),
    );

    const usage = accumulator.snapshotUsage();

    expect(usage.provider).toBe("openai.responses");
    expect(usage.modelId).toBe("gpt-5.6-sol");
  });

  it("prices each model request before calculating an attempt delta", () => {
    const accumulator = createAccumulator();
    const beforeAttempt = accumulator.snapshotUsage();

    accumulator.onStepFinish(
      createModelStep({
        inputTokens: 150_000,
        outputTokens: 0,
        provider: "openai.responses",
        modelId: "gpt-5.4",
        billingClass: "cache_write",
      }),
    );
    accumulator.onStepFinish(
      createModelStep({
        inputTokens: 150_000,
        outputTokens: 0,
        provider: "openai.responses",
        modelId: "gpt-5.4",
        billingClass: "cache_write",
        stepNumber: 1,
      }),
    );

    const attempt = accumulator.usageDeltaSince(beforeAttempt);

    expect(attempt.inputTokens).toBe(300_000);
    expect(attempt.estimatedCostUsd).toBeCloseTo(0.75, 6);
  });

  it("persists the accumulated request cost on the run row", () => {
    const accumulator = createAccumulator();

    accumulator.onStepFinish(
      createModelStep({
        inputTokens: 1_000,
        outputTokens: 1_000,
        provider: "openai.responses",
        modelId: "gpt-5.4",
      }),
    );

    expect(accumulator.toRow().totalCostUsd).toBeCloseTo(0.0175, 6);
  });
});
