import { saveMessage } from "@convex-dev/agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { components } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import {
  getScheduledFailureContent,
  persistScheduledFailure,
  resolveUserProviderConfig,
  resolveUserProviderCredentials,
  shouldNotifyScheduledFailure,
} from "./chatHelpers";
import { BYOK_REQUIRED_AFTER } from "./byok";

vi.mock("@convex-dev/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/agent")>()),
  saveMessage: vi.fn(async () => undefined),
}));

describe("getScheduledFailureContent", () => {
  it("returns the missing-key message for BYOK-required users", () => {
    expect(getScheduledFailureContent(new Error("byok_key_missing"), "claude")).toBe(
      "You need to add an API key in Settings before chat can run.",
    );
  });

  it("returns the model-missing message before provider classification", () => {
    expect(getScheduledFailureContent(new Error("byok_model_missing"), "openrouter")).toBe(
      "The selected provider needs a model name before chat can start. Add one in Settings and try again.",
    );
  });

  it("returns the house-key cap message for grandfathered users", () => {
    expect(getScheduledFailureContent(new Error("house_key_quota_exhausted"), "gemini")).toBe(
      "You've used your 500 free AI messages this month. Add your own API key in Settings to keep going.",
    );
  });

  it("uses the provider-specific BYOK message for sanitized error codes", () => {
    const message = getScheduledFailureContent(new Error("byok_quota_exceeded"), "openai");
    expect(message).toContain("OpenAI is rejecting requests");
    expect(message).toContain("billing");
  });

  it("uses the generic fallback when no provider is known", () => {
    expect(getScheduledFailureContent(new Error("byok_key_invalid"))).toBe(
      "Your API key isn't working anymore. Check it in Settings and try again.",
    );
  });

  it("classifies raw provider errors when a provider is known", () => {
    const message = getScheduledFailureContent(
      new Error("You exceeded your current quota: insufficient_quota."),
      "openai",
    );
    expect(message).toContain("OpenAI is rejecting requests");
  });

  it("falls back to the generic chat error for unexpected failures", () => {
    expect(getScheduledFailureContent(new Error("database blew up"), "claude")).toBe(
      "I'm having trouble right now. Please try again in a moment.",
    );
  });

  it("falls back to the generic chat error for classifiable errors without a known provider", () => {
    expect(
      getScheduledFailureContent(new Error("You exceeded your current quota: insufficient_quota.")),
    ).toBe("I'm having trouble right now. Please try again in a moment.");
  });

  it("attributes 'high demand' errors to the upstream provider when provider is known", () => {
    const msg = getScheduledFailureContent(
      new Error("This model is currently experiencing high demand. Please try again later."),
      "gemini",
    );
    expect(msg).toContain("Google Gemini");
    expect(msg).toContain("not Roni");
    expect(msg).toContain("(/settings)");
  });

  it("attributes transient server errors to the provider", () => {
    const error = Object.assign(new Error("Internal"), { status: 503 });
    const msg = getScheduledFailureContent(error, "claude");
    expect(msg).toContain("Anthropic Claude");
  });

  it("stays generic for transient errors when provider is unknown", () => {
    expect(
      getScheduledFailureContent(new Error("This model is currently experiencing high demand.")),
    ).toBe("I'm having trouble right now. Please try again in a moment.");
  });
});

describe("shouldNotifyScheduledFailure", () => {
  it("does not notify on expected sentinel errors", () => {
    expect(shouldNotifyScheduledFailure(new Error("byok_key_missing"))).toBe(false);
    expect(shouldNotifyScheduledFailure(new Error("byok_model_missing"))).toBe(false);
    expect(shouldNotifyScheduledFailure(new Error("house_key_quota_exhausted"))).toBe(false);
  });

  it("does not notify on classified provider-state errors", () => {
    expect(
      shouldNotifyScheduledFailure(
        new Error("You exceeded your current quota: insufficient_quota."),
      ),
    ).toBe(false);
  });

  it("notifies on unexpected failures", () => {
    expect(shouldNotifyScheduledFailure(new Error("database blew up"))).toBe(true);
  });

  it("does not notify on transient provider outages", () => {
    expect(
      shouldNotifyScheduledFailure(new Error("This model is currently experiencing high demand.")),
    ).toBe(false);
    expect(
      shouldNotifyScheduledFailure(Object.assign(new Error("Unavailable"), { status: 503 })),
    ).toBe(false);
  });
});

describe("provider credential quota", () => {
  it("resolves background credentials without consuming a second chat quota unit", async () => {
    const originalHouseKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    const originalKillSwitch = process.env.BYOK_DISABLED;
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "AIzaHouseKey00000000000000000000000abcd";
    delete process.env.BYOK_DISABLED;
    try {
      const runMutation = vi.fn(async () => undefined);
      const ctx = {
        runQuery: vi.fn(async () => ({
          profile: null,
          userCreationTime: BYOK_REQUIRED_AFTER - 1,
        })),
        runMutation,
      } as unknown as ActionCtx;

      await expect(resolveUserProviderCredentials(ctx, "user-1")).resolves.toMatchObject({
        provider: "gemini",
        isHouseKey: true,
      });
      expect(runMutation).not.toHaveBeenCalled();

      await resolveUserProviderConfig(ctx, "user-1");
      expect(runMutation).toHaveBeenCalledTimes(1);
    } finally {
      if (originalHouseKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      else process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalHouseKey;
      if (originalKillSwitch === undefined) delete process.env.BYOK_DISABLED;
      else process.env.BYOK_DISABLED = originalKillSwitch;
    }
  });
});

describe("persistScheduledFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("anchors the fallback response to the failed turn", async () => {
    await persistScheduledFailure({
      ctx: { runAction: vi.fn() } as unknown as ActionCtx,
      threadId: "thread-1",
      promptMessageId: "prompt-1",
      userId: "user-1",
      error: new Error("byok_key_missing"),
      provider: "gemini",
      source: "chatProcessing.processMessage",
    });

    expect(saveMessage).toHaveBeenCalledWith(
      expect.anything(),
      components.agent,
      expect.objectContaining({
        threadId: "thread-1",
        promptMessageId: "prompt-1",
        userId: "user-1",
      }),
    );
  });

  it("does not fail a durable terminal response when alert scheduling is unavailable", async () => {
    const runAfter = vi.fn(async () => {
      throw new Error("scheduler unavailable");
    });

    await expect(
      persistScheduledFailure({
        ctx: { scheduler: { runAfter } } as unknown as ActionCtx,
        threadId: "thread-1",
        promptMessageId: "prompt-1",
        userId: "user-1",
        error: new Error("database blew up"),
        provider: "gemini",
        source: "chatProcessing.processMessage",
      }),
    ).resolves.toBeUndefined();

    expect(saveMessage).toHaveBeenCalled();
    expect(runAfter).toHaveBeenCalledWith(0, expect.anything(), {
      source: "chatProcessing.processMessage",
      message: "unexpected_scheduled_failure",
      userId: "user-1",
    });
  });
});
