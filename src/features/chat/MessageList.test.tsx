import { type MessageDoc, toUIMessages } from "@convex-dev/agent";
import type { UIMessage } from "@convex-dev/agent/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";

const chatMessageMock = vi.fn(
  ({ isGrouped, message }: { isGrouped?: boolean; message: UIMessage }) => (
    <div data-testid="chat-message">
      {message.key}:{isGrouped ? "grouped" : "solo"}
    </div>
  ),
);

vi.mock("./ChatMessage", () => ({
  ChatMessage: (props: { isGrouped?: boolean; message: UIMessage }) => chatMessageMock(props),
}));

vi.mock("@/features/chat/DateDivider", () => ({
  DateDivider: ({ timestamp }: { timestamp: number }) => (
    <div data-testid="date-divider">{timestamp}</div>
  ),
}));

function createMessage(overrides: Partial<UIMessage>): UIMessage {
  return {
    id: "message-1",
    key: "message-1",
    _creationTime: Date.UTC(2026, 0, 1, 10, 0),
    order: 0,
    parts: [{ text: "Hello", type: "text" }],
    role: "user",
    status: "success",
    stepOrder: 0,
    text: "Hello",
    ...overrides,
  };
}

function createApprovalMessage(): UIMessage {
  const message: MessageDoc = {
    _id: "message-approval",
    _creationTime: Date.UTC(2026, 0, 1, 10, 0),
    message: {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tool-call-static",
          toolName: "approve_week_plan",
          input: { weekStartDate: "2026-04-06" },
        },
        {
          type: "tool-approval-request",
          approvalId: "approval-static",
          toolCallId: "tool-call-static",
        },
      ],
    },
    order: 1,
    status: "success",
    stepOrder: 0,
    threadId: "thread-1",
    tool: true,
  };

  return toUIMessages([message])[0];
}

describe("MessageList", () => {
  it("groups consecutive messages on the same day", () => {
    const messages = [
      createMessage({ key: "one" }),
      createMessage({
        _creationTime: Date.UTC(2026, 0, 1, 10, 5),
        key: "two",
        text: "Second",
      }),
    ];

    render(<MessageList messages={messages} threadId="thread-1" />);

    expect(screen.getAllByTestId("chat-message")).toHaveLength(2);
    expect(screen.getAllByTestId("chat-message")[0]).toHaveTextContent("one:solo");
    expect(screen.getAllByTestId("chat-message")[1]).toHaveTextContent("two:grouped");
    expect(screen.getAllByTestId("date-divider")).toHaveLength(1);
  });

  it("adds a new date divider when the day changes", () => {
    const messages = [
      createMessage({ key: "one" }),
      createMessage({
        _creationTime: Date.UTC(2026, 0, 2, 8, 0),
        key: "two",
        text: "Next day",
      }),
    ];

    render(<MessageList messages={messages} threadId="thread-1" />);

    expect(screen.getAllByTestId("date-divider")).toHaveLength(2);
    expect(screen.getAllByTestId("chat-message")[1]).toHaveTextContent("two:solo");
  });

  it("hides assistant messages with no visible text or tool parts", () => {
    const messages = [
      createMessage({ key: "one", role: "assistant", text: "Visible assistant" }),
      createMessage({
        key: "two",
        parts: [],
        role: "assistant",
        text: "   ",
      }),
    ];

    render(<MessageList messages={messages} threadId="thread-1" />);

    expect(screen.getAllByTestId("chat-message")).toHaveLength(1);
    expect(screen.queryByText("two:solo")).not.toBeInTheDocument();
  });

  it("keeps tool-only stored approval requests visible", () => {
    render(<MessageList messages={[createApprovalMessage()]} threadId="thread-1" />);

    expect(screen.getByTestId("chat-message")).toBeInTheDocument();
  });

  it("hides an empty failed row while its retry lease is active", () => {
    const messages = [
      createMessage({
        key: "retrying",
        metadata: { roniTurn: { phase: "retrying" } },
        parts: [],
        role: "assistant",
        status: "failed",
        text: "",
      }),
    ];

    render(<MessageList messages={messages} threadId="thread-1" />);

    expect(screen.queryByTestId("chat-message")).not.toBeInTheDocument();
  });
});
