import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useImageUpload } from "./useImageUpload";

function fileList(files: readonly File[]): FileList {
  return files as unknown as FileList;
}

function uploadResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

describe("useImageUpload", () => {
  let nextPreviewId = 0;

  beforeEach(() => {
    nextPreviewId = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${++nextPreviewId}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reuses uploaded storage IDs when the message is retried", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(uploadResponse({ storageId: "storage-a" }))
      .mockResolvedValueOnce(uploadResponse({ storageId: "storage-b" }));
    vi.stubGlobal("fetch", fetchMock);
    const generateUploadUrl = vi.fn(async () => "https://upload.example");
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.png", { type: "image/png" });
    const { result } = renderHook(() => useImageUpload());

    act(() => {
      expect(result.current.addImages(fileList([first, second]))).toBeNull();
    });

    let initialIds: string[] = [];
    let retryIds: string[] = [];
    await act(async () => {
      initialIds = await result.current.uploadAll(generateUploadUrl);
      retryIds = await result.current.uploadAll(generateUploadUrl);
    });

    expect(initialIds).toEqual(["storage-a", "storage-b"]);
    expect(retryIds).toEqual(initialIds);
    expect(generateUploadUrl).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses earlier uploads after a later image fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(uploadResponse({ storageId: "storage-a" }))
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(uploadResponse({ storageId: "storage-b" }));
    vi.stubGlobal("fetch", fetchMock);
    const generateUploadUrl = vi.fn(async () => "https://upload.example");
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.png", { type: "image/png" });
    const { result } = renderHook(() => useImageUpload());

    act(() => {
      result.current.addImages(fileList([first, second]));
    });

    await expect(
      act(async () => await result.current.uploadAll(generateUploadUrl)),
    ).rejects.toThrow("network unavailable");

    let retryIds: string[] = [];
    await act(async () => {
      retryIds = await result.current.uploadAll(generateUploadUrl);
    });

    expect(retryIds).toEqual(["storage-a", "storage-b"]);
    expect(generateUploadUrl).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not cache a malformed upload response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(uploadResponse({ id: "missing-storage-id" }))
      .mockResolvedValueOnce(uploadResponse({ storageId: "storage-a" }));
    vi.stubGlobal("fetch", fetchMock);
    const generateUploadUrl = vi.fn(async () => "https://upload.example");
    const image = new File(["image"], "image.png", { type: "image/png" });
    const { result } = renderHook(() => useImageUpload());

    act(() => {
      result.current.addImages(fileList([image]));
    });

    await expect(
      act(async () => await result.current.uploadAll(generateUploadUrl)),
    ).rejects.toThrow("invalid storage response");

    let retryIds: string[] = [];
    await act(async () => {
      retryIds = await result.current.uploadAll(generateUploadUrl);
    });

    expect(retryIds).toEqual(["storage-a"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates only removed or cleared attachment IDs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(uploadResponse({ storageId: "storage-a" }))
      .mockResolvedValueOnce(uploadResponse({ storageId: "storage-b" }))
      .mockResolvedValueOnce(uploadResponse({ storageId: "storage-c" }));
    vi.stubGlobal("fetch", fetchMock);
    const generateUploadUrl = vi.fn(async () => "https://upload.example");
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.png", { type: "image/png" });
    const { result } = renderHook(() => useImageUpload());

    act(() => {
      result.current.addImages(fileList([first, second]));
    });
    await act(async () => {
      await result.current.uploadAll(generateUploadUrl);
    });

    act(() => result.current.removeImage(0));
    let retainedIds: string[] = [];
    await act(async () => {
      retainedIds = await result.current.uploadAll(generateUploadUrl);
    });
    expect(retainedIds).toEqual(["storage-b"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() => {
      result.current.clearAll();
      result.current.addImages(fileList([first]));
    });
    let replacementIds: string[] = [];
    await act(async () => {
      replacementIds = await result.current.uploadAll(generateUploadUrl);
    });

    expect(replacementIds).toEqual(["storage-c"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
