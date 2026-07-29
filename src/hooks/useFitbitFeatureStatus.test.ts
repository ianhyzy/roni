import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFitbitFeatureStatus } from "./useFitbitFeatureStatus";

const mockGetFitbitFeatureStatus = vi.fn();

vi.mock("convex/react", () => ({
  useAction: () => mockGetFitbitFeatureStatus,
}));

vi.mock("../../convex/_generated/api", () => ({
  api: {
    fitbit: {
      connections: {
        getFitbitFeatureStatus: "fitbit:connections:getFitbitFeatureStatus",
      },
    },
  },
}));

describe("useFitbitFeatureStatus", () => {
  beforeEach(() => {
    mockGetFitbitFeatureStatus.mockReset();
  });

  it("exposes loading and success states", async () => {
    mockGetFitbitFeatureStatus.mockResolvedValueOnce({ enabled: true, hasConnection: false });

    const { result } = renderHook(() => useFitbitFeatureStatus());

    expect(result.current.state).toEqual({ status: "loading" });
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "success",
        data: { enabled: true, hasConnection: false },
      });
    });
  });

  it("exposes action failures and retries immediately", async () => {
    mockGetFitbitFeatureStatus
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ enabled: false, hasConnection: true });

    const { result } = renderHook(() => useFitbitFeatureStatus());

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: "error" });
    });

    act(() => result.current.refetch());

    expect(result.current.state).toEqual({ status: "loading" });
    await waitFor(() => {
      expect(result.current.state).toEqual({
        status: "success",
        data: { enabled: false, hasConnection: true },
      });
    });
    expect(mockGetFitbitFeatureStatus).toHaveBeenCalledTimes(2);
  });
});
