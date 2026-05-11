import { describe, expect, it } from "vitest";
import { classifyPromptIntent, selectCoachTierRoute } from "./chatProcessing";

describe("classifyPromptIntent", () => {
  const chars = (length: number) => "x".repeat(length);

  it("routes short low-intent messages as trivial", () => {
    expect(classifyPromptIntent("hello")).toBe("trivial");
    expect(classifyPromptIntent("thanks!")).toBe("trivial");
  });

  it("uses a strict length boundary for trivial messages", () => {
    expect(classifyPromptIntent(chars(29))).toBe("trivial");
    expect(classifyPromptIntent(chars(30))).toBe("default");
  });

  it("keeps short programming and tool commands complex", () => {
    expect(classifyPromptIntent("push it")).toBe("complex");
    expect(classifyPromptIntent("swap bench press")).toBe("complex");
  });

  it("routes longer non-keyword messages as default", () => {
    expect(classifyPromptIntent("How should I think about my last workout?")).toBe("default");
  });
});

describe("selectCoachTierRoute", () => {
  const tierAgents = {
    router: { name: "router" },
    chat: { name: "chat" },
    programming: { name: "programming" },
    summarize: { name: "summarize" },
  };
  const tierModelNames = {
    router: "router-model",
    chat: "chat-model",
    programming: "programming-model",
    summarize: "summarize-model",
  };

  it("uses the router model as the first attempt for trivial prompts", () => {
    const route = selectCoachTierRoute(
      {
        tierAgents,
        tierModelNames,
        fallbackModelName: "router-model",
      },
      "trivial",
    );

    expect(route.primary).toBe(tierAgents.router);
    expect(route.fallback).toBe(tierAgents.chat);
    expect(route.primaryModelName).toBe("router-model");
    expect(route.fallbackModelName).toBe("chat-model");
    expect(route.primaryTier).toBe("router");
    expect(route.fallbackTier).toBe("chat");
  });

  it("uses the programming model first for complex prompts", () => {
    const route = selectCoachTierRoute(
      {
        tierAgents,
        tierModelNames,
        fallbackModelName: "router-model",
      },
      "complex",
    );

    expect(route.primary).toBe(tierAgents.programming);
    expect(route.fallback).toBe(tierAgents.chat);
    expect(route.primaryModelName).toBe("programming-model");
    expect(route.fallbackModelName).toBe("chat-model");
    expect(route.primaryTier).toBe("programming");
    expect(route.fallbackTier).toBe("chat");
  });

  it("uses the chat model first for default prompts", () => {
    const route = selectCoachTierRoute(
      {
        tierAgents,
        tierModelNames,
        fallbackModelName: "router-model",
      },
      "default",
    );

    expect(route.primary).toBe(tierAgents.chat);
    expect(route.fallback).toBe(tierAgents.router);
    expect(route.primaryModelName).toBe("chat-model");
    expect(route.fallbackModelName).toBe("router-model");
    expect(route.primaryTier).toBe("chat");
    expect(route.fallbackTier).toBe("router");
  });

  it("uses programming then chat for approval continuation", () => {
    const route = selectCoachTierRoute(
      {
        tierAgents,
        tierModelNames,
        fallbackModelName: "router-model",
      },
      "approval_continuation",
    );

    expect(route.primary).toBe(tierAgents.programming);
    expect(route.fallback).toBe(tierAgents.chat);
    expect(route.primaryModelName).toBe("programming-model");
    expect(route.fallbackModelName).toBe("chat-model");
    expect(route.primaryTier).toBe("programming");
    expect(route.fallbackTier).toBe("chat");
  });

  it("keeps the selected tier as fallback when the provider has no fallback model", () => {
    const route = selectCoachTierRoute(
      {
        tierAgents,
        tierModelNames: {
          router: "openrouter/auto",
          chat: "openrouter/auto",
          programming: "openrouter/auto",
          summarize: "openrouter/auto",
        },
        fallbackModelName: null,
      },
      "trivial",
    );

    expect(route.primary).toBe(tierAgents.router);
    expect(route.fallback).toBe(tierAgents.router);
    expect(route.primaryModelName).toBe("openrouter/auto");
    expect(route.fallbackModelName).toBeNull();
    expect(route.primaryTier).toBe("router");
    expect(route.fallbackTier).toBe("router");
  });
});
