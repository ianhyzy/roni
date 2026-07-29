import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatInput } from "./ChatInput";

const mocks = vi.hoisted(() => ({
  addImages: vi.fn(),
  clearAll: vi.fn(),
  generateUploadUrl: vi.fn(async () => ({ uploadUrl: "https://upload.example" })),
  removeImage: vi.fn(),
  sendMessage: vi.fn(),
  track: vi.fn(),
  uploadAll: vi.fn(),
}));

let pendingImages: Array<{ id: string }> = [];

vi.mock("convex/react", () => ({
  useMutation: () =>
    Object.assign(mocks.generateUploadUrl, {
      withOptimisticUpdate: () => mocks.sendMessage,
    }),
}));

vi.mock("@convex-dev/agent/react", () => ({
  optimisticallySendMessage: () => vi.fn(),
}));

vi.mock("@/hooks/useImageUpload", () => ({
  useImageUpload: () => ({
    pendingImages,
    addImages: mocks.addImages,
    removeImage: mocks.removeImage,
    uploadAll: mocks.uploadAll,
    clearAll: mocks.clearAll,
    isUploading: false,
  }),
}));

vi.mock("./ImagePreviewRow", () => ({
  ImagePreviewRow: () => null,
}));

vi.mock("@/lib/analytics", () => ({
  useAnalytics: () => ({ track: mocks.track }),
}));

vi.mock("@/lib/timezone", () => ({
  getBrowserTimezone: () => "America/Denver",
}));

describe("ChatInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingImages = [];
    mocks.sendMessage.mockResolvedValue({ threadId: "thread-1" });
    mocks.uploadAll.mockResolvedValue(["storage-1"]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rolls back the parent pending turn when sending fails", async () => {
    const onSend = vi.fn();
    const onSendError = vi.fn();
    mocks.sendMessage.mockRejectedValueOnce(new Error("network unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ChatInput threadId="thread-1" onSend={onSend} onSendError={onSendError} />);

    fireEvent.change(screen.getByLabelText("Message input"), {
      target: { value: "Build today's workout" },
    });
    fireEvent.click(screen.getByLabelText("Send message"));

    expect(onSend).toHaveBeenCalledWith("Build today's workout");
    await waitFor(() => expect(onSendError).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("Message input")).toHaveValue("Build today's workout");
  });

  it("preserves attached images when the message mutation fails", async () => {
    const onSendError = vi.fn();
    pendingImages = [{ id: "image-1" }];
    mocks.sendMessage.mockRejectedValueOnce(new Error("network unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<ChatInput threadId="thread-1" onSendError={onSendError} />);

    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(onSendError).toHaveBeenCalledTimes(1));
    expect(mocks.clearAll).not.toHaveBeenCalled();
  });

  it("uses the same canonical prompt for image-only optimistic and server messages", async () => {
    const onSend = vi.fn();
    pendingImages = [{ id: "image-1" }];
    render(<ChatInput threadId="thread-1" onSend={onSend} />);

    fireEvent.click(screen.getByLabelText("Send message"));

    const prompt = "What do you see in these images?";
    expect(onSend).toHaveBeenCalledWith(prompt);
    await waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ prompt, threadId: "thread-1" }),
      ),
    );
    expect(mocks.clearAll).toHaveBeenCalledTimes(1);
  });
});
