import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { stripOrphanedToolCalls } from "./contextWindow";

describe("stripOrphanedToolCalls", () => {
  it("passes through messages with no tool calls", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(stripOrphanedToolCalls(msgs)).toEqual(msgs);
  });

  it("keeps paired tool-call and tool-result", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "check scores" },
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
      { role: "assistant", content: "Your scores are great." },
    ];
    expect(stripOrphanedToolCalls(msgs)).toEqual(msgs);
  });

  it("drops a stale approval response when a fresh user prompt follows before execution", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Approve this push?" },
          { type: "tool-call", toolCallId: "tc1", toolName: "approve_week_plan", input: {} },
          { type: "tool-approval-request", approvalId: "ap1", toolCallId: "tc1" },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "ap1", approved: true }],
      },
      { role: "user", content: "Looks good" },
    ];

    expect(stripOrphanedToolCalls(msgs)).toEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "Approve this push?" }],
      },
      { role: "user", content: "Looks good" },
    ]);
  });

  it("drops an approval response when a later assistant message makes it uncollectable", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "push it" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Approve this push?" },
          { type: "tool-call", toolCallId: "tc1", toolName: "approve_week_plan", input: {} },
          { type: "tool-approval-request", approvalId: "ap1", toolCallId: "tc1" },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "ap1", approved: true }],
      },
      { role: "assistant", content: "Execution started but did not finish." },
    ];

    expect(stripOrphanedToolCalls(msgs)).toEqual([
      { role: "user", content: "push it" },
      {
        role: "assistant",
        content: [{ type: "text", text: "Approve this push?" }],
      },
      { role: "assistant", content: "Execution started but did not finish." },
    ]);
  });

  it("keeps tool-calls when an approval request is still pending (no fresh user follow-up)", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "deploy the plan" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "approve_week_plan", input: {} },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Approve this push?" },
          { type: "tool-approval-request", approvalId: "ap1", toolCallId: "tc1" },
        ],
      },
    ];

    const result = stripOrphanedToolCalls(msgs);

    expect(result).toEqual(msgs);
  });

  it("strips a split persisted approval pair abandoned by a fresh user message", () => {
    // Reproduces Gemini's "function call turn comes immediately after a user
    // turn or after a function response turn" error: an unresolved tool-call
    // followed by a fresh user prompt has no matching tool-result, so Gemini
    // rejects the conversation. The fix strips the orphan.
    const msgs: ModelMessage[] = [
      { role: "user", content: "deploy the plan" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "approve_week_plan", input: {} },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Approve this push?" },
          { type: "tool-approval-request", approvalId: "ap1", toolCallId: "tc1" },
          { type: "reasoning", text: "Keep this context." },
        ],
      },
      { role: "user", content: "actually nevermind, what does this change?" },
    ];

    const result = stripOrphanedToolCalls(msgs);

    expect(result).toHaveLength(3);
    expect(result[1].content).toEqual([
      { type: "text", text: "Approve this push?" },
      { type: "reasoning", text: "Keep this context." },
    ]);
  });

  it("drops an approval response whose request was trimmed out of the window", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "push it" },
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "ap1", approved: true }],
      },
    ] as unknown as ModelMessage[];

    const result = stripOrphanedToolCalls(msgs);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("keeps an active approval request and response together", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "push it" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "approve_week_plan", input: {} },
          { type: "tool-approval-request", approvalId: "ap1", toolCallId: "tc1" },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "ap1", approved: true }],
      },
    ] as unknown as ModelMessage[];

    const result = stripOrphanedToolCalls(msgs);

    expect(result).toEqual(msgs);
  });

  it("removes orphaned tool-call with no matching tool-result", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "check scores" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc-orphan", toolName: "get_scores", input: {} },
        ],
      },
      { role: "user", content: "try again" },
    ];
    const result = stripOrphanedToolCalls(msgs);
    expect(result).toEqual([
      { role: "user", content: "check scores" },
      { role: "user", content: "try again" },
    ]);
  });

  it("keeps text parts when only some tool-calls are orphaned", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool-call", toolCallId: "tc-good", toolName: "get_scores", input: {} },
          { type: "tool-call", toolCallId: "tc-orphan", toolName: "search", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-good",
            toolName: "get_scores",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ];
    const result = stripOrphanedToolCalls(msgs);
    expect(result).toHaveLength(3);
    const assistantContent = result[1].content as Array<{ type: string; toolCallId?: string }>;
    expect(assistantContent).toHaveLength(2);
    expect(assistantContent[0]).toEqual({ type: "text", text: "Let me check." });
    expect(assistantContent[1].toolCallId).toBe("tc-good");
  });

  it("handles string content on assistant messages", () => {
    const msgs: ModelMessage[] = [{ role: "assistant", content: "just text" }];
    expect(stripOrphanedToolCalls(msgs)).toEqual(msgs);
  });

  it("removes orphaned tool-result whose tool-call was already stripped", () => {
    // A partially-persisted retry left a tool role message with a tool-result
    // that has no preceding assistant tool-call in the history.
    const msgs: ModelMessage[] = [
      { role: "user", content: "check scores" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-orphan",
            toolName: "get_scores",
            output: { type: "text", value: "leftover" },
          },
        ],
      },
      { role: "user", content: "try again" },
    ];

    const result = stripOrphanedToolCalls(msgs);

    expect(result).toEqual([
      { role: "user", content: "check scores" },
      { role: "user", content: "try again" },
    ]);
  });

  it("keeps tool messages whose tool-result references a paired assistant tool-call", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "check scores" },
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
      { role: "assistant", content: "Your scores are great." },
    ];

    expect(stripOrphanedToolCalls(msgs)).toEqual(msgs);
  });

  it("removes approval metadata from a completed lifecycle", () => {
    const msgs: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Approve this push?" },
          { type: "tool-call", toolCallId: "tc1", toolName: "approve_week_plan", input: {} },
          { type: "tool-approval-request", approvalId: "ap1", toolCallId: "tc1" },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "ap1", approved: true }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "approve_week_plan",
            output: { type: "text", value: "pushed" },
          },
        ],
      },
      { role: "user", content: "Looks good" },
    ];

    const result = stripOrphanedToolCalls(msgs);

    const partTypes = result.flatMap((message) =>
      Array.isArray(message.content) ? message.content.map((part) => part.type) : [],
    );
    expect(result).toHaveLength(3);
    expect(partTypes).toEqual(["text", "tool-call", "tool-result"]);
  });

  it("strips only orphaned tool-result parts when message has mixed parts", () => {
    // One tool-result references a kept assistant tool-call (tc-kept);
    // another references a tool-call that was never emitted (tc-orphan).
    // The orphaned part must be removed; the kept part must stay.
    const msgs: ModelMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "tc-kept", toolName: "get_scores", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-kept",
            toolName: "get_scores",
            output: { type: "text", value: "ok" },
          },
          {
            type: "tool-result",
            toolCallId: "tc-orphan",
            toolName: "search",
            output: { type: "text", value: "stale" },
          },
        ],
      },
      { role: "assistant", content: "Here you go." },
    ];

    const result = stripOrphanedToolCalls(msgs);

    const toolMsg = result.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const parts = toolMsg!.content as Array<{ type: string; toolCallId?: string }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].toolCallId).toBe("tc-kept");
  });
});
