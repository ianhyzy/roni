import type { UIMessage } from "@convex-dev/agent/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatThread } from "./ChatThread";

let currentMessages: UIMessage[] = [];

vi.mock("@convex-dev/agent/react", async () => {
  const actual =
    await vi.importActual<typeof import("@convex-dev/agent/react")>("@convex-dev/agent/react");
  return {
    ...actual,
    useUIMessages: () => ({
      loadMore: vi.fn(),
      results: currentMessages,
      status: "Exhausted",
    }),
  };
});

vi.mock("convex/react", () => ({
  useQuery: () => undefined,
}));

vi.mock("./MessageList", () => ({
  MessageList: () => <div data-testid="messages" />,
}));

vi.mock("./ThinkingIndicator", () => ({
  ThinkingIndicator: ({ startedAt }: { startedAt: number }) => (
    <div data-testid="thinking">{startedAt}</div>
  ),
}));

vi.mock("./ChatInput", () => ({
  ChatInput: ({ disabled, onSend }: { disabled?: boolean; onSend?: (text: string) => void }) => (
    <button data-testid="composer" disabled={disabled} onClick={() => onSend?.("New message")}>
      Composer
    </button>
  ),
}));

function createMessage(overrides: Partial<UIMessage> = {}): UIMessage {
  return {
    id: "message-1",
    key: "message-1",
    _creationTime: 1_000,
    order: 0,
    parts: [{ text: "Hello", type: "text" }],
    role: "user",
    status: "success",
    stepOrder: 0,
    text: "Hello",
    ...overrides,
  };
}

describe("ChatThread", () => {
  beforeEach(() => {
    currentMessages = [];
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("locks the composer while a local optimistic message is visible", () => {
    render(<ChatThread threadId="thread-1" />);

    const composer = screen.getByTestId("composer");
    expect(composer).toBeEnabled();
    fireEvent.click(composer);
    expect(composer).toBeDisabled();
    expect(screen.getByText("Sending message...")).toBeInTheDocument();
  });

  it("does not treat an older identical prompt as server confirmation", () => {
    const now = Date.now();
    currentMessages = [
      createMessage({ _creationTime: now - 10_000, text: "New message" }),
      createMessage({ _creationTime: now - 9_000, role: "assistant", status: "success" }),
    ];
    const { rerender } = render(<ChatThread threadId="thread-1" />);

    fireEvent.click(screen.getByTestId("composer"));
    expect(screen.getByTestId("composer")).toBeDisabled();
    expect(screen.getByText("Sending message...")).toBeInTheDocument();

    currentMessages = [
      ...currentMessages,
      createMessage({
        _creationTime: Date.now(),
        key: "new-user",
        order: 1,
        text: "New message",
      }),
    ];
    rerender(<ChatThread threadId="thread-1" />);
    expect(screen.queryByText("Sending message...")).not.toBeInTheDocument();
    expect(screen.getByTestId("thinking")).toBeInTheDocument();
  });

  it("shows preparation feedback but avoids duplicating tool or response feedback", () => {
    const createdAt = Date.now();
    const user = createMessage({ _creationTime: createdAt });
    currentMessages = [user];
    const { rerender } = render(<ChatThread threadId="thread-1" />);

    expect(screen.getByTestId("composer")).toBeDisabled();
    expect(screen.getByTestId("thinking")).toHaveTextContent(String(createdAt));

    currentMessages = [
      user,
      createMessage({
        parts: [
          {
            input: {},
            state: "input-available",
            toolCallId: "call-1",
            toolName: "search_exercises",
            type: "dynamic-tool",
          },
        ],
        role: "assistant",
        status: "streaming",
        text: "",
      }),
    ];
    rerender(<ChatThread threadId="thread-1" />);
    expect(screen.getByTestId("composer")).toBeDisabled();
    expect(screen.queryByTestId("thinking")).not.toBeInTheDocument();

    currentMessages = [
      user,
      createMessage({ role: "assistant", status: "streaming", text: "Here is your plan" }),
    ];
    rerender(<ChatThread threadId="thread-1" />);
    expect(screen.getByTestId("composer")).toBeDisabled();
    expect(screen.queryByTestId("thinking")).not.toBeInTheDocument();
  });

  it("unlocks the composer after a terminal response", () => {
    currentMessages = [
      createMessage({ _creationTime: Date.now() - 100 }),
      createMessage({ _creationTime: Date.now(), role: "assistant", status: "success" }),
    ];

    render(<ChatThread threadId="thread-1" />);

    expect(screen.getByTestId("composer")).toBeEnabled();
    expect(screen.queryByTestId("thinking")).not.toBeInTheDocument();
  });

  it("locks the composer for the durable retry lease instead of a client timer", () => {
    vi.useFakeTimers();
    const failedAt = Date.now() - 60_000;
    currentMessages = [
      createMessage({ _creationTime: failedAt - 100 }),
      createMessage({
        _creationTime: failedAt,
        metadata: { roniTurn: { phase: "retrying" } },
        parts: [],
        role: "assistant",
        status: "failed",
        text: "",
      }),
    ];

    const { rerender } = render(<ChatThread threadId="thread-1" />);

    expect(screen.getByTestId("composer")).toBeDisabled();

    act(() => vi.advanceTimersByTime(60_000));

    expect(screen.getByTestId("composer")).toBeDisabled();

    currentMessages = currentMessages.map((message) => ({ ...message, metadata: undefined }));
    rerender(<ChatThread threadId="thread-1" />);

    expect(screen.getByTestId("composer")).toBeEnabled();
  });

  it("keeps the composer locked when a retry starts after a failed attempt", () => {
    const createdAt = Date.now();
    currentMessages = [
      createMessage({ _creationTime: createdAt - 100 }),
      createMessage({
        _creationTime: createdAt - 50,
        parts: [],
        role: "assistant",
        status: "failed",
        text: "",
      }),
      createMessage({
        _creationTime: createdAt,
        parts: [{ text: "Trying again", type: "text" }],
        role: "assistant",
        status: "streaming",
        text: "Trying again",
      }),
    ];

    render(<ChatThread threadId="thread-1" />);

    expect(screen.getByTestId("composer")).toBeDisabled();
  });

  it("keeps the composer locked while an approval is pending and continues", () => {
    const createdAt = Date.now();
    const user = createMessage({ _creationTime: createdAt });
    const approvalRequestTool = {
      approval: { id: "approval-1" },
      input: {},
      state: "approval-requested",
      toolCallId: "call-1",
      toolName: "approve_week_plan",
      type: "dynamic-tool",
    } satisfies UIMessage["parts"][number];
    const approvedTool = {
      approval: { approved: true, id: "approval-1" },
      input: {},
      state: "approval-responded",
      toolCallId: "call-1",
      toolName: "approve_week_plan",
      type: "dynamic-tool",
    } satisfies UIMessage["parts"][number];
    currentMessages = [
      user,
      createMessage({
        _creationTime: createdAt,
        parts: [approvalRequestTool],
        role: "assistant",
        status: "success",
        text: "",
      }),
    ];
    const { rerender } = render(<ChatThread threadId="thread-1" />);

    expect(screen.getByTestId("composer")).toBeDisabled();
    expect(screen.queryByTestId("thinking")).not.toBeInTheDocument();

    currentMessages = [
      user,
      createMessage({
        _creationTime: createdAt,
        parts: [approvedTool],
        role: "assistant",
        status: "success",
        text: "",
      }),
    ];
    rerender(<ChatThread threadId="thread-1" />);

    expect(screen.getByTestId("composer")).toBeDisabled();
    expect(screen.getByTestId("thinking")).toBeInTheDocument();

    currentMessages = [
      user,
      createMessage({
        _creationTime: createdAt,
        parts: [approvedTool, { text: "Your workouts are ready.", type: "text" }],
        role: "assistant",
        status: "success",
        text: "Your workouts are ready.",
      }),
    ];
    rerender(<ChatThread threadId="thread-1" />);

    expect(screen.getByTestId("composer")).toBeEnabled();
    expect(screen.queryByTestId("thinking")).not.toBeInTheDocument();
  });
});
