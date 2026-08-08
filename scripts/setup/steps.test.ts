import { beforeEach, describe, expect, it, vi } from "vitest";
import { setConvexEnv } from "./convex";
import type { Prompter } from "./prompts";
import { stepSetGoogleKey } from "./steps";

vi.mock("./convex", () => ({
  readConvexEnv: vi.fn(),
  runConvexDevOnce: vi.fn(),
  setConvexEnv: vi.fn(),
}));

function createPrompter(secret: string): Prompter {
  return {
    text: vi.fn(async () => ""),
    secret: vi.fn(async () => secret),
    yesNo: vi.fn(async () => false),
    close: vi.fn(),
  };
}

describe("stepSetGoogleKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores a current AQ-dot-prefixed Google key", async () => {
    const key = "AQ." + "X".repeat(36);

    await stepSetGoogleKey(createPrompter(key), new Set());

    expect(setConvexEnv).toHaveBeenCalledWith("GOOGLE_GENERATIVE_AI_API_KEY", key);
  });

  it("rejects a key from another provider", async () => {
    const result = stepSetGoogleKey(createPrompter("sk-wrong-provider-key"), new Set());

    await expect(result).rejects.toThrow(/expected 'AQ\.\.\.' or 'AIza\.\.\.' format/);
    expect(setConvexEnv).not.toHaveBeenCalled();
  });
});
