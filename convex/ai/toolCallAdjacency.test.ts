import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { stripOrphanedToolCalls } from "./contextWindow";

// Adjacency-repair pass (PostHog issue 019d510a).
//
// Gemini rejects history where an assistant function-call turn isn't
// immediately followed by a function-response turn. The set-based logic in
// stripOrphanedToolCalls proves a tool-result/approval-response exists
// *somewhere*; the adjacency pass enforces that it sits in the slot Gemini
// requires. These tests exercise the second pass specifically.
describe("stripOrphanedToolCalls — adjacency repair", () => {
  it("drops a tool-call when the next message is a text-only assistant", () => {
    // The set-based pass would keep tc1 (its result is in history far away),
    // but the adjacency pass drops it because the immediate next turn is not
    // a tool message. We keep the assistant text-only message that follows.
    const msgs: ModelMessage[] = [
      { role: "user", content: "check scores" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc1", toolName: "get_scores", input: {} }],
      },
      { role: "assistant", content: [{ type: "text", text: "Stale assistant turn" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "get_scores",
            output: { type: "text", value: "ok" },
          },
        ],
      },
      { role: "user", content: "follow up" },
    ];

    const result = stripOrphanedToolCalls(msgs);

    expect(result.find((m) => m.role === "tool")).toBeUndefined();
    const assistantMsgs = result.filter((m) => m.role === "assistant");
    expect(assistantMsgs).toHaveLength(1);
    const surviving = assistantMsgs[0].content as Array<{ type: string }>;
    expect(surviving).toEqual([{ type: "text", text: "Stale assistant turn" }]);
  });

  it("drops a tool-call but keeps text when next message is a fresh user", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me search." },
          { type: "tool-call", toolCallId: "tc1", toolName: "search", input: {} },
        ],
      },
      { role: "user", content: "actually nevermind" },
    ];

    const result = stripOrphanedToolCalls(msgs);

    expect(result).toHaveLength(3);
    const assistantContent = result[1].content as Array<{ type: string; text?: string }>;
    expect(assistantContent).toHaveLength(1);
    expect(assistantContent[0]).toEqual({ type: "text", text: "Let me search." });
  });

  it("preserves an assistant tool-call when next message has matching tool-result", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "scores" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc1", toolName: "get_scores", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "get_scores",
            output: { type: "text", value: "done" },
          },
        ],
      },
      { role: "assistant", content: "Here are your scores." },
    ];

    expect(stripOrphanedToolCalls(msgs)).toEqual(msgs);
  });

  it("drops a tool-call AND the mismatched tool message when toolCallIds don't pair", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "scores" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-X", toolName: "get_scores", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-Y",
            toolName: "search",
            output: { type: "text", value: "wrong" },
          },
        ],
      },
      { role: "user", content: "next" },
    ];

    const result = stripOrphanedToolCalls(msgs);

    expect(result).toEqual([
      { role: "user", content: "scores" },
      { role: "user", content: "next" },
    ]);
  });

  it("preserves a tool-call paired by tool-approval-response via approvalId", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "deploy please" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Approve?" },
          { type: "tool-call", toolCallId: "tc1", toolName: "approve_week_plan", input: {} },
          { type: "tool-approval-request", approvalId: "ap1", toolCallId: "tc1" },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "ap1", approved: true }],
      },
      { role: "user", content: "ok" },
    ];

    expect(stripOrphanedToolCalls(msgs)).toEqual(msgs);
  });

  it("drops a tool message at the start with no preceding assistant", () => {
    const msgs: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-orphan",
            toolName: "search",
            output: { type: "text", value: "leftover" },
          },
        ],
      },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello" },
    ];

    const result = stripOrphanedToolCalls(msgs);

    expect(result.find((m) => m.role === "tool")).toBeUndefined();
    expect(result).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("drops a tool message when the previous message is also a tool message", () => {
    // Two consecutive tool messages cannot both pair with the same preceding
    // assistant turn; the second has no assistant tool-call directly before it.
    const msgs: ModelMessage[] = [
      { role: "user", content: "scores" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc1", toolName: "get_scores", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "get_scores",
            output: { type: "text", value: "ok" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "get_scores",
            output: { type: "text", value: "duplicate" },
          },
        ],
      },
      { role: "assistant", content: "Done" },
    ];

    const result = stripOrphanedToolCalls(msgs);

    const toolMsgs = result.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
    const parts = toolMsgs[0].content as Array<{ type: string; output: { value: string } }>;
    expect(parts[0].output.value).toBe("ok");
  });
});
