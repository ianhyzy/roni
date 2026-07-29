import { describe, expect, it } from "vitest";
import type { CaptureResult } from "posthog-js";
import { posthogBeforeSend, shouldDropPosthogEvent } from "./posthogBeforeSend";

function makeEvent(overrides: Partial<CaptureResult>): CaptureResult {
  return {
    uuid: "00000000-0000-0000-0000-000000000000",
    event: "$exception",
    properties: {},
    ...overrides,
  } as CaptureResult;
}

describe("shouldDropPosthogEvent", () => {
  it("returns false for non-exception events", () => {
    const event = makeEvent({
      event: "$pageview",
      properties: { $exception_message: "function call turn comes immediately after" },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(false);
  });

  it("returns false for null events", () => {
    const dropped = shouldDropPosthogEvent(null);

    expect(dropped).toBe(false);
  });

  it("drops Gemini turn-ordering errors", () => {
    const event = makeEvent({
      properties: {
        $exception_message:
          "Please ensure that function call turn comes immediately after a user turn or after a function response turn.",
      },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops Gemini quota errors", () => {
    const event = makeEvent({
      properties: {
        $exception_values: [{ value: "You exceeded your current quota, please check..." }],
      },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops AI SDK retry-wrapped quota errors", () => {
    const event = makeEvent({
      properties: {
        $exception_values: [
          {
            value:
              "Failed after 3 attempts. Last error: You exceeded your current quota, please check your plan and billing details.",
          },
        ],
      },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops Gemini prepayment-credits-depleted billing errors", () => {
    const event = makeEvent({
      properties: {
        $exception_values: [
          {
            value:
              "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.",
          },
        ],
      },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops Gemini high-demand errors", () => {
    const event = makeEvent({
      properties: {
        $exception_values: [{ value: "This model is currently experiencing high demand." }],
      },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops provider_overload sanitized finalize codes re-thrown by the client stream consumer", () => {
    const event = makeEvent({ properties: { $exception_message: "provider_overload" } });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops rate_limit sanitized finalize codes re-thrown by the client stream consumer", () => {
    const event = makeEvent({ properties: { $exception_message: "rate_limit" } });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops context_limit sanitized finalize codes re-thrown by the client stream consumer", () => {
    const event = makeEvent({ properties: { $exception_message: "context_limit" } });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops Gemini free-tier metric quota errors (generate_content_free_tier_requests)", () => {
    const event = makeEvent({
      properties: {
        $exception_values: [
          {
            value:
              "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3-flash",
          },
        ],
      },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops Gemini free-tier input_token_count quota errors (generate_content_free_tier_input_token_count)", () => {
    const event = makeEvent({
      properties: {
        $exception_values: [
          {
            value:
              "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000, model: gemini-2.5-flash-lite",
          },
        ],
      },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops free-tier quota errors wrapped in AI SDK retry message", () => {
    const event = makeEvent({
      properties: {
        $exception_message: "Error reading stream",
        $exception_values: [
          {
            value:
              "Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3-flash",
          },
        ],
      },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops third-party minified n.standardSelectors errors", () => {
    const event = makeEvent({
      properties: {
        $exception_message:
          "TypeError: Cannot read properties of undefined (reading 'n.standardSelectors')",
      },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops Firefox reader-mode injection errors", () => {
    const event = makeEvent({
      properties: {
        $exception_message: "undefined is not an object (evaluating 'window.__firefox__.reader')",
      },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops Chrome extension runtime.sendMessage noise", () => {
    const event = makeEvent({
      properties: {
        $exception_list: [{ value: "Invalid call to runtime.sendMessage(). Tab not found." }],
      },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops BYOK error codes", () => {
    const event = makeEvent({ properties: { $exception_message: "byok_quota_exceeded" } });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("drops cross-origin Script error noise", () => {
    const event = makeEvent({ properties: { $exception_message: "Script error." } });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(true);
  });

  it("keeps real errors", () => {
    const event = makeEvent({
      properties: { $exception_message: "Cannot read properties of undefined (reading 'foo')" },
    });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(false);
  });

  it("returns false when there is no exception payload", () => {
    const event = makeEvent({ properties: {} });

    const dropped = shouldDropPosthogEvent(event);

    expect(dropped).toBe(false);
  });
});

describe("posthogBeforeSend", () => {
  it("returns null for suppressed events", () => {
    const event = makeEvent({
      properties: { $exception_message: "ResizeObserver loop completed" },
    });

    const result = posthogBeforeSend(event);

    expect(result).toBeNull();
  });

  it("passes through unsuppressed events unchanged", () => {
    const event = makeEvent({ properties: { $exception_message: "TypeError: real bug" } });

    const result = posthogBeforeSend(event);

    expect(result).toBe(event);
  });

  it("redacts every sensitive OAuth key from URL properties without leaking values", () => {
    const event = makeEvent({
      event: "$pageview",
      properties: {
        $current_url:
          "https://roni.coach/fitbit/callback?code=code-secret&state=state-secret&ticket=ticket-secret&oauth_token=token-secret&oauth_verifier=verifier-secret&safe=kept#status",
      },
    });

    const result = posthogBeforeSend(event);

    expect(result?.properties.$current_url).toBe(
      "https://roni.coach/fitbit/callback?code=[REDACTED]&state=[REDACTED]&ticket=[REDACTED]&oauth_token=[REDACTED]&oauth_verifier=[REDACTED]&safe=kept#status",
    );
    expect(JSON.stringify(result)).not.toContain("code-secret");
    expect(JSON.stringify(result)).not.toContain("state-secret");
    expect(JSON.stringify(result)).not.toContain("ticket-secret");
    expect(JSON.stringify(result)).not.toContain("token-secret");
    expect(JSON.stringify(result)).not.toContain("verifier-secret");
  });

  it("sanitizes relative and nested URL-like properties, including percent-encoded underscores", () => {
    const event = makeEvent({
      event: "$autocapture",
      properties: {
        $pathname: "/fitbit/callback?ticket=opaque%2Bticket",
        $elements: [
          {
            attr__href: "/oauth/callback?oauth%5Ftoken=token-value&oauth%5fverifier=verifier-value",
          },
        ],
      },
      $set_once: {
        $initial_current_url: "https://roni.coach/callback?STATE=initial-state",
      },
    });

    const result = posthogBeforeSend(event);

    expect(result?.properties.$pathname).toBe("/fitbit/callback?ticket=[REDACTED]");
    expect(result?.properties.$elements).toEqual([
      {
        attr__href: "/oauth/callback?oauth%5Ftoken=[REDACTED]&oauth%5fverifier=[REDACTED]",
      },
    ]);
    expect(result?.$set_once?.$initial_current_url).toBe(
      "https://roni.coach/callback?STATE=[REDACTED]",
    );
  });

  it("preserves safe URL parameters", () => {
    const event = makeEvent({
      event: "$pageview",
      properties: { $current_url: "https://roni.coach/settings?fitbit=connected" },
    });

    const result = posthogBeforeSend(event);

    expect(result).toBe(event);
  });

  it("passes through null events unchanged", () => {
    const result = posthogBeforeSend(null);

    expect(result).toBeNull();
  });
});
