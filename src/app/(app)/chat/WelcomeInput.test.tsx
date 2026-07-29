import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeInput } from "./WelcomeInput";

const mocks = vi.hoisted(() => ({
  addImages: vi.fn(),
  clearAll: vi.fn(),
  generateUploadUrl: vi.fn(async () => ({ uploadUrl: "https://upload.example" })),
  removeImage: vi.fn(),
  track: vi.fn(),
  uploadAll: vi.fn(async () => ["storage-1"]),
}));

let pendingImages: Array<{ id: string }> = [];

vi.mock("convex/react", () => ({
  useMutation: () => mocks.generateUploadUrl,
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

vi.mock("@/features/chat/ImagePreviewRow", () => ({
  ImagePreviewRow: () => null,
}));

vi.mock("@/lib/analytics", () => ({
  useAnalytics: () => ({ track: mocks.track }),
}));

describe("WelcomeInput", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingImages = [{ id: "image-1" }];
  });

  it("retains attachments when creating the thread fails", async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    render(<WelcomeInput sendMessage={sendMessage} />);

    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(mocks.uploadAll).toHaveBeenCalledTimes(1);
    expect(mocks.clearAll).not.toHaveBeenCalled();
  });

  it("clears attachments only after the thread message succeeds", async () => {
    let resolveSend: ((value: { threadId: string }) => void) | undefined;
    const sendMessage = vi.fn(
      () =>
        new Promise<{ threadId: string }>((resolve) => {
          resolveSend = resolve;
        }),
    );
    render(<WelcomeInput sendMessage={sendMessage} />);

    fireEvent.click(screen.getByLabelText("Send message"));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(mocks.clearAll).not.toHaveBeenCalled();

    resolveSend?.({ threadId: "thread-1" });
    await waitFor(() => expect(mocks.clearAll).toHaveBeenCalledTimes(1));
  });
});
