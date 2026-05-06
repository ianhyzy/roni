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

  it("maps 'model is currently overloaded' to provider_overload", () => {
    const error = new Error("The model is currently overloaded. Please try again later.");

    const finalizeCode = getFinalizeCodeForError(error);

    expect(finalizeCode).toBe("provider_overload");
    expect(finalizeCode).not.toContain("overloaded");
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

  it("returns a sanitized code (never the raw error message) for every transient kind", () => {
    // Ensure no transient error leaks its raw message into the finalize reason.
    const cases: [string, string][] = [
      ["This model is currently experiencing high demand.", "provider_overload"],
      ["The model is currently overloaded.", "provider_overload"],
      ["Service busy — please try again later.", "provider_overload"],
      ["Request timed out after 180s", "timeout"],
      ["fetch failed", "network"],
    ];

    for (const [msg, expectedCode] of cases) {
      const error = msg === "fetch failed" ? new TypeError(msg) : new Error(msg);
      if (msg.includes("timed out")) error.name = "TimeoutError";
      const code = getFinalizeCodeForError(error);
      expect(code, `expected sanitized code for: ${msg}`).toBe(expectedCode);
      expect(code, `raw message leaked for: ${msg}`).not.toContain(msg.slice(0, 10));
    }
  });
});
