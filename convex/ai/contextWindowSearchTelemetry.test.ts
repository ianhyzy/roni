import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { type CoachContextTiming, makeCoachAgentConfig } from "./coach";
import { buildSearchTelemetryContextWindow } from "./contextWindowSearchTelemetry";

function buildSearchWindow(
  messages: ModelMessage[],
  searchMessages: ModelMessage[],
  promptBudgetTokens: number = 50_000,
) {
  return buildSearchTelemetryContextWindow({
    messages,
    searchMessages,
    promptBudgetTokens,
    reservedPromptTokens: 0,
  });
}

async function runCoachContextHandler(
  allMessages: ModelMessage[],
  search: ModelMessage[],
  timing: CoachContextTiming,
): Promise<ModelMessage[]> {
  const contextHandler = makeCoachAgentConfig({ timing }).contextHandler!;
  return contextHandler(undefined as never, {
    allMessages,
    search,
    recent: [],
    inputMessages: [],
    inputPrompt: [],
    existingResponses: [],
    userId: undefined,
    threadId: undefined,
  });
}

describe("buildSearchTelemetryContextWindow", () => {
  it("does not count an orphaned search result as used", () => {
    const orphanedSearch: ModelMessage = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "orphaned", toolName: "search_exercises", input: {} },
      ],
    };
    const messages: ModelMessage[] = [orphanedSearch, { role: "user", content: "new question" }];

    expect(buildSearchWindow(messages, [orphanedSearch])).toEqual({
      messages: [{ role: "user", content: "new question" }],
      searchUsed: false,
    });
  });

  it("keeps provenance through old-image normalization and same-role merging", () => {
    const searchImage: ModelMessage = {
      role: "user",
      content: [{ type: "image", image: new URL("https://example.com/old.jpg") }],
    };
    const messages: ModelMessage[] = [
      { role: "user", content: "earlier context" },
      searchImage,
      { role: "assistant", content: "answer" },
      { role: "user", content: "latest context" },
    ];

    const result = buildSearchWindow(messages, [searchImage]);

    expect(result.searchUsed).toBe(true);
    expect(result.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "earlier context" },
        { type: "text", text: "[image message]" },
      ],
    });
  });

  it("reports unused when the final budget window drops the search turn", () => {
    const searchMessage: ModelMessage = { role: "user", content: "x".repeat(80) };
    const messages: ModelMessage[] = [
      searchMessage,
      { role: "assistant", content: "old answer" },
      { role: "user", content: "latest" },
    ];

    const result = buildSearchWindow(messages, [searchMessage], 10);

    expect(result.messages).toEqual([{ role: "user", content: "latest" }]);
    expect(result.searchUsed).toBe(false);
  });

  it("does not attribute an identical recent message without matching object identity", () => {
    const recentMessage: ModelMessage = { role: "user", content: "same content" };
    const distinctSearchMessage: ModelMessage = { role: "user", content: "same content" };

    const result = buildSearchWindow([recentMessage], [distinctSearchMessage]);

    expect(result.searchUsed).toBe(false);
  });

  it("does not mutate inputs or expose provenance symbols to the provider", () => {
    const searchMessage: ModelMessage = { role: "user", content: "remember this" };
    const messages = [searchMessage];

    const result = buildSearchWindow(messages, [searchMessage]);

    expect(Object.getOwnPropertySymbols(searchMessage)).toEqual([]);
    expect(Object.getOwnPropertySymbols(result.messages[0])).toEqual([]);
    expect(result.messages[0]).not.toBe(searchMessage);
  });
});

describe("coach context search telemetry", () => {
  it("assigns metrics from the latest completed context build", async () => {
    const timing = { searchHits: 99, searchUsed: true };
    const searchMessage: ModelMessage = { role: "user", content: "prior context" };
    const secondSearchMessage: ModelMessage = { role: "assistant", content: "prior response" };

    await runCoachContextHandler(
      [searchMessage, secondSearchMessage],
      [searchMessage, secondSearchMessage],
      timing,
    );
    expect(timing).toMatchObject({ searchHits: 2, searchUsed: true });

    await runCoachContextHandler([{ role: "user", content: "latest context" }], [], timing);
    expect(timing).toMatchObject({ searchHits: 0, searchUsed: false });
  });

  it("records a search hit as unused when orphan cleanup removes it", async () => {
    const timing = {};
    const orphanedSearch: ModelMessage = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "orphaned", toolName: "search_exercises", input: {} },
      ],
    };

    await runCoachContextHandler(
      [orphanedSearch, { role: "user", content: "new question" }],
      [orphanedSearch],
      timing,
    );
    expect(timing).toMatchObject({ searchHits: 1, searchUsed: false });
  });
});
