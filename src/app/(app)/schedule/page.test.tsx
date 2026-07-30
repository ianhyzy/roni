import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SchedulePage from "./page";
import type { ScheduleData } from "../../../../convex/schedule";

const mockScheduleAction =
  vi.fn<(args: { userTimezone?: string }) => Promise<ScheduleData | null>>();
const mockTrack = vi.fn();
const mockGetBrowserTimezone = vi.fn<() => string | undefined>();

vi.mock("convex/react", () => ({
  useAction: () => mockScheduleAction,
}));

vi.mock("@/lib/analytics", () => ({
  useAnalytics: () => ({ track: mockTrack }),
}));

vi.mock("@/lib/timezone", () => ({
  getBrowserTimezone: () => mockGetBrowserTimezone(),
}));

vi.mock("../../../../convex/_generated/api", () => ({
  api: {
    schedule: {
      getScheduleData: "schedule:getScheduleData",
    },
  },
}));

describe("SchedulePage", () => {
  beforeEach(() => {
    mockScheduleAction.mockReset();
    mockScheduleAction.mockResolvedValue(null);
    mockTrack.mockReset();
    mockGetBrowserTimezone.mockReset();
    mockGetBrowserTimezone.mockReturnValue("America/Denver");
  });

  it("loads the schedule for the browser timezone", async () => {
    render(<SchedulePage />);

    await waitFor(() => {
      expect(mockScheduleAction).toHaveBeenCalledTimes(1);
      expect(mockScheduleAction).toHaveBeenCalledWith({ userTimezone: "America/Denver" });
    });
  });

  it("omits the timezone when the browser timezone is unavailable", async () => {
    mockGetBrowserTimezone.mockReturnValue(undefined);

    render(<SchedulePage />);

    await waitFor(() => {
      expect(mockScheduleAction).toHaveBeenCalledTimes(1);
      expect(mockScheduleAction).toHaveBeenCalledWith({});
    });
  });

  it("rechecks the browser timezone when retrying a failed load", async () => {
    mockScheduleAction
      .mockRejectedValueOnce(new Error("Schedule load failed"))
      .mockResolvedValueOnce(null);
    mockGetBrowserTimezone.mockReturnValueOnce(undefined).mockReturnValue("America/Denver");

    render(<SchedulePage />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(mockScheduleAction.mock.calls).toEqual([[{}], [{ userTimezone: "America/Denver" }]]);
    });
  });
});
