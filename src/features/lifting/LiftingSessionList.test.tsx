import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import { LiftingSessionList } from "./LiftingSessionList";
import type { LiftingSessionDetail, LiftingSessionSummary } from "./liftingForm";

const mockSaveSession = vi.fn();
const mockDeleteSession = vi.fn();
const mockUseQuery = vi.fn<(ref: string, args: unknown) => unknown>();
let mockSessions: readonly LiftingSessionSummary[] | undefined;
let mockDetail: LiftingSessionDetail | null | undefined;

const sessionId = "lifting-session-1" as Id<"liftingSessions">;

function createSummary(): LiftingSessionSummary {
  return {
    sessionId,
    source: "manual",
    performedAt: new Date(2026, 6, 30, 18, 45).getTime(),
    calendarDate: "2026-07-30",
    title: "Evening strength",
    durationMinutes: 45,
    notes: "Strong finish",
    exerciseCount: 1,
    setCount: 1,
    totalReps: 5,
    totalVolumeLbs: 925,
    createdAt: 100,
    updatedAt: 200,
  };
}

function createDetail(): LiftingSessionDetail {
  return {
    ...createSummary(),
    exercises: [
      {
        exerciseId: "lifting-exercise-1" as Id<"liftingExercises">,
        order: 0,
        name: "Back squat",
        setCount: 1,
        totalReps: 5,
        totalVolumeLbs: 925,
        sets: [
          {
            setId: "lifting-set-1" as Id<"liftingSets">,
            order: 0,
            kind: "working",
            reps: 5,
            weightLbs: 185,
            rpe: 8,
          },
        ],
      },
    ],
  };
}

vi.mock("convex/react", () => ({
  useMutation: (ref: string) => {
    if (ref === "liftingSessions:saveMine") return mockSaveSession;
    if (ref === "liftingSessions:deleteMine") return mockDeleteSession;
    throw new Error(`Unexpected mutation ${ref}`);
  },
  useQuery: (ref: string, args: unknown) => mockUseQuery(ref, args),
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    liftingSessions: {
      deleteMine: "liftingSessions:deleteMine",
      getMine: "liftingSessions:getMine",
      listMine: "liftingSessions:listMine",
      saveMine: "liftingSessions:saveMine",
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("LiftingSessionList", () => {
  beforeEach(() => {
    mockSaveSession.mockReset();
    mockDeleteSession.mockReset();
    mockSessions = [];
    mockDetail = undefined;
    mockUseQuery.mockReset();
    mockUseQuery.mockImplementation((ref, args) => {
      if (ref === "liftingSessions:listMine") return mockSessions;
      if (ref === "liftingSessions:getMine") return args === "skip" ? undefined : mockDetail;
      throw new Error(`Unexpected query ${ref}`);
    });
  });

  it("renders a non-interactive loading state while summaries load", () => {
    mockSessions = undefined;

    render(<LiftingSessionList />);

    expect(screen.getByRole("status", { name: "Loading lifting sessions" })).toBeVisible();
    expect(screen.queryByText("No manual sessions yet")).not.toBeInTheDocument();
    expect(mockUseQuery).toHaveBeenCalledWith("liftingSessions:listMine", { limit: 50 });
    expect(mockUseQuery).toHaveBeenCalledWith("liftingSessions:getMine", "skip");
  });

  it("shows an empty state that can start a new session", () => {
    render(<LiftingSessionList />);

    expect(screen.getByText("No manual sessions yet")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Log your first session" }));

    expect(screen.getByRole("heading", { name: "Log lifting session" })).toBeVisible();
    expect(screen.getByLabelText("Session title")).toBeVisible();
  });

  it("renders a zero-minute duration and omits a null duration", () => {
    mockSessions = [{ ...createSummary(), durationMinutes: 0 }];
    const view = render(<LiftingSessionList />);

    expect(screen.getByText("925 lb volume · 0 min")).toBeVisible();

    mockSessions = [{ ...createSummary(), durationMinutes: null }];
    view.rerender(<LiftingSessionList />);

    expect(screen.getByText("925 lb volume")).toBeVisible();
    expect(screen.queryByText("925 lb volume · 0 min")).not.toBeInTheDocument();
  });

  it("loads the selected summary with the exact detail query", () => {
    mockSessions = [createSummary()];
    const view = render(<LiftingSessionList />);

    fireEvent.click(screen.getByRole("button", { name: /Evening strength/ }));

    expect(screen.getByRole("status", { name: "Loading lifting session" })).toBeVisible();
    expect(mockUseQuery).toHaveBeenCalledWith("liftingSessions:getMine", { sessionId });

    mockDetail = createDetail();
    view.rerender(<LiftingSessionList />);

    expect(screen.getByRole("heading", { name: "Lifting session" })).toBeVisible();
    expect(screen.getByText("Back squat")).toBeVisible();
  });

  it("waits for detail before initializing the edit form", () => {
    mockSessions = [createSummary()];
    mockDetail = createDetail();
    const view = render(<LiftingSessionList />);
    fireEvent.click(screen.getByRole("button", { name: /Evening strength/ }));

    mockDetail = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("heading", { name: "Edit lifting session" })).toBeVisible();
    expect(screen.getByRole("status", { name: "Loading lifting session" })).toBeVisible();
    expect(screen.queryByLabelText("Session title")).not.toBeInTheDocument();

    mockDetail = createDetail();
    view.rerender(<LiftingSessionList />);

    expect(screen.getByLabelText("Session title")).toHaveValue("Evening strength");
    expect(screen.getByLabelText("Performed date")).toHaveValue("2026-07-30");
    expect(screen.getByLabelText("Performed time")).toHaveValue("18:45");
    expect(screen.getByLabelText("Exercise name")).toHaveValue("Back squat");
  });

  it("moves focus to the heading after each view transition", () => {
    mockSessions = [createSummary()];
    mockDetail = createDetail();
    render(<LiftingSessionList />);

    fireEvent.click(screen.getByRole("button", { name: /Evening strength/ }));
    expect(screen.getByRole("heading", { name: "Lifting session" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("heading", { name: "Edit lifting session" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Back to session" }));
    expect(screen.getByRole("heading", { name: "Lifting session" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    expect(screen.getByRole("heading", { name: "Manual lifting" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Log session" }));
    expect(screen.getByRole("heading", { name: "Log lifting session" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("heading", { name: "Manual lifting" })).toHaveFocus();
  });
});
