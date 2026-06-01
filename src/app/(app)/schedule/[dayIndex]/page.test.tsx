import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ScheduleDayPage from "./page";
import type { ScheduleData } from "../../../../../convex/schedule";

const mockScheduleAction = vi.fn<() => Promise<ScheduleData | null>>();
const mockOtherAction = vi.fn();
const mockTrack = vi.fn();
let garminFeatureThrows = false;
type FulfilledParams = Promise<{ dayIndex: string }> & {
  status: "fulfilled";
  value: { dayIndex: string };
};

vi.mock("convex/react", () => ({
  useAction: (ref: string) => {
    if (ref === "schedule:getScheduleData") return mockScheduleAction;
    return mockOtherAction;
  },
  useQuery: (ref: string) => {
    if (ref === "garmin:connections:getGarminFeatureStatus") {
      if (garminFeatureThrows) throw new Error("Garmin feature query failed");
      return { enabled: true };
    }
    if (ref === "garmin:connections:getMyGarminStatus") {
      return { state: "none" };
    }
    if (ref === "garmin:workoutDelivery:getMyWorkoutDelivery") {
      return { status: "none" };
    }
    return undefined;
  },
}));

vi.mock("@/lib/analytics", () => ({
  useAnalytics: () => ({ track: mockTrack }),
}));

vi.mock("../../../../../convex/_generated/api", () => ({
  api: {
    schedule: {
      getScheduleData: "schedule:getScheduleData",
    },
    garmin: {
      connections: {
        getGarminFeatureStatus: "garmin:connections:getGarminFeatureStatus",
        getMyGarminStatus: "garmin:connections:getMyGarminStatus",
      },
      workoutDelivery: {
        getMyWorkoutDelivery: "garmin:workoutDelivery:getMyWorkoutDelivery",
        sendWorkoutPlanToGarmin: "garmin:workoutDelivery:sendWorkoutPlanToGarmin",
      },
    },
  },
}));

const scheduleData: ScheduleData = {
  weekStartDate: "2026-06-01",
  days: [
    {
      dayIndex: 0,
      dayName: "Monday",
      date: "2026-06-01",
      sessionType: "push",
      derivedStatus: "programmed",
      workoutPlanId: "j1234567890abcdef" as ScheduleData["days"][number]["workoutPlanId"],
      workoutTitle: "Push - Monday",
      exercises: [{ name: "Bench Press", sets: 4, reps: 10 }],
      estimatedDuration: 45,
    },
  ],
};

function renderPage() {
  const params = Promise.resolve({ dayIndex: "0" }) as FulfilledParams;
  params.status = "fulfilled";
  params.value = { dayIndex: "0" };

  return render(
    <Suspense fallback={<div>Loading route</div>}>
      <ScheduleDayPage params={params} />
    </Suspense>,
  );
}

describe("ScheduleDayPage", () => {
  beforeEach(() => {
    mockScheduleAction.mockReset();
    mockOtherAction.mockReset();
    mockTrack.mockReset();
    garminFeatureThrows = false;
  });

  it("keeps workout details visible and logs when optional Garmin status fails", async () => {
    mockScheduleAction.mockResolvedValue(scheduleData);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    garminFeatureThrows = true;

    try {
      renderPage();

      await waitFor(() => {
        expect(screen.getByRole("heading", { name: /monday, june 1/i })).toBeInTheDocument();
      });
      expect(screen.getByText("Push - Monday")).toBeInTheDocument();
      expect(screen.getByText("Bench Press")).toBeInTheDocument();
      expect(screen.getByText("Garmin unavailable")).toBeInTheDocument();
      expect(consoleError).toHaveBeenCalledWith(
        "Optional Garmin delivery card failed",
        expect.any(Error),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("lets the optional Garmin panel recover after a transient query error", async () => {
    mockScheduleAction.mockResolvedValue(scheduleData);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    garminFeatureThrows = true;

    try {
      renderPage();

      expect(await screen.findByText("Garmin unavailable")).toBeInTheDocument();

      garminFeatureThrows = false;
      fireEvent.click(screen.getByRole("button", { name: /retry garmin/i }));

      await waitFor(() => {
        expect(screen.getByText("Connect Garmin")).toBeInTheDocument();
      });
      expect(screen.queryByText("Garmin unavailable")).toBeNull();
    } finally {
      consoleError.mockRestore();
    }
  });
});
