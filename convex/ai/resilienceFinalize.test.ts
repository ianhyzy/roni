import { describe, expect, it } from "vitest";
import { getFinalizeCodeForError } from "./resilience";

describe("getFinalizeCodeForError", () => {
  it("uses transient kind codes instead of raw provider messages", () => {
    const error = new Error(
      "This model is currently experiencing high demand. Please try again later.",
    );

    const finalizeCode = getFinalizeCodeForError(error);

    expect(finalizeCode).toBe("provider_overload");
    expect(finalizeCode).not.toContain("high demand");
  });

  it("uses the Error name for non-transient errors", () => {
    const error = new Error("database blew up unexpectedly");

    const finalizeCode = getFinalizeCodeForError(error);

    expect(finalizeCode).toBe("Error");
    expect(finalizeCode).not.toBe(error.message);
  });

  it("falls back to unknown_error for non-Error values", () => {
    const finalizeCode = getFinalizeCodeForError("oops string");

    expect(finalizeCode).toBe("unknown_error");
  });

  it("does not persist a custom error name", () => {
    const error = new Error("provider body containing a secret");
    error.name = "leaked-api-key";

    expect(getFinalizeCodeForError(error)).toBe("unexpected_error");
  });

  it("maps provider_response_failed to provider_overload finalize code", () => {
    // provider_response_failed is the synthetic error thrown when finishReason:"error"
    // resolves without a thrown exception. After being classified as transient, if all
    // retries are exhausted the finalize code must be a clean provider_overload string
    // (not "Error" / the raw error name) so the user sees an attributed message.
    const error = new Error("provider_response_failed");

    const finalizeCode = getFinalizeCodeForError(error);

    expect(finalizeCode).toBe("provider_overload");
    expect(finalizeCode).not.toBe("Error");
  });
});
