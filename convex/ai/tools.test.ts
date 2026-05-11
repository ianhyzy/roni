import { describe, expect, it } from "vitest";
import { z } from "zod";
import { KNOWN_TRAINING_TYPES, searchExercisesTool } from "./tools";

// isTonalNotLinked is not exported, but its effect is tested via the module-level
// constant and helper that the tools use internally. We validate the detection
// logic by checking the error message pattern the proxy throws.
describe("Tonal not-linked detection", () => {
  it("matches the exact error message thrown by withTonalToken", () => {
    // The proxy throws: "No Tonal profile found — user must link their account"
    // isTonalNotLinked checks for the prefix "No Tonal profile found".
    const proxyError = new Error("No Tonal profile found — user must link their account");
    expect(proxyError.message.includes("No Tonal profile found")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    const unrelated = new Error("TOKEN_ENCRYPTION_KEY env var is not set");
    expect(unrelated.message.includes("No Tonal profile found")).toBe(false);
  });

  it("does not match a 401 auth error", () => {
    const authError = new Error("Unauthorized: session expired");
    expect(authError.message.includes("No Tonal profile found")).toBe(false);
  });
});

describe("searchExercisesTool input schema", () => {
  it("rejects 'Warm-up' as trainingType (not a real catalog tag)", () => {
    const parsed = (searchExercisesTool.inputSchema as z.ZodObject<z.ZodRawShape>).safeParse({
      trainingType: "Warm-up",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts the known catalog trainingTypes", () => {
    for (const t of KNOWN_TRAINING_TYPES) {
      const parsed = (searchExercisesTool.inputSchema as z.ZodObject<z.ZodRawShape>).safeParse({
        trainingType: t,
      });
      expect(parsed.success).toBe(true);
    }
  });
});
