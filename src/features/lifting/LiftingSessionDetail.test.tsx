import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { Id } from "../../../convex/_generated/dataModel";
import { LiftingSessionDetail } from "./LiftingSessionDetail";
import type { LiftingSessionDetail as LiftingSessionDetailData } from "./liftingForm";

const mockDeleteSession = vi.fn();
const sessionId = "lifting-session-1" as Id<"liftingSessions">;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createDetail(): LiftingSessionDetailData {
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
    if (ref === "liftingSessions:deleteMine") return mockDeleteSession;
    throw new Error(`Unexpected mutation ${ref}`);
  },
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    liftingSessions: {
      deleteMine: "liftingSessions:deleteMine",
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("LiftingSessionDetail", () => {
  beforeEach(() => {
    mockDeleteSession.mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  it("renders a recorded zero-minute duration", () => {
    const session = { ...createDetail(), durationMinutes: 0 };

    render(<LiftingSessionDetail session={session} onEdit={vi.fn()} onDeleted={vi.fn()} />);

    expect(screen.getByText("0 min")).toBeVisible();
    expect(screen.queryByText("Not recorded")).not.toBeInTheDocument();
  });

  it("deletes the confirmed session once while the request is pending", async () => {
    const deletion = createDeferred<null>();
    const onDeleted = vi.fn();
    mockDeleteSession.mockReturnValueOnce(deletion.promise);
    render(
      <LiftingSessionDetail session={createDetail()} onEdit={vi.fn()} onDeleted={onDeleted} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("heading", { name: "Delete this lifting session?" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));

    expect(mockDeleteSession).toHaveBeenCalledWith({ sessionId });
    const pendingButton = screen.getByRole("button", { name: "Deleting session" });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
    fireEvent.click(pendingButton);
    expect(mockDeleteSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      deletion.resolve(null);
      await deletion.promise;
    });

    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith("Lifting session deleted");
  });

  it("deletes once when two confirmation events happen in the same turn", async () => {
    const deletion = createDeferred<null>();
    mockDeleteSession.mockReturnValue(deletion.promise);
    render(<LiftingSessionDetail session={createDetail()} onEdit={vi.fn()} onDeleted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmButton = screen.getByRole("button", { name: "Delete session" });

    act(() => {
      fireEvent.click(confirmButton);
      fireEvent.click(confirmButton);
    });

    expect(mockDeleteSession).toHaveBeenCalledTimes(1);
    await act(async () => deletion.resolve(null));
  });

  it("keeps confirmation open and reports a rejected deletion", async () => {
    const onDeleted = vi.fn();
    mockDeleteSession.mockRejectedValueOnce(new Error("Delete unavailable"));
    render(
      <LiftingSessionDetail session={createDetail()} onEdit={vi.fn()} onDeleted={onDeleted} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Delete unavailable");
    expect(screen.getByRole("heading", { name: "Delete this lifting session?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete session" })).toBeEnabled();
    expect(toast.error).toHaveBeenCalledWith("Delete unavailable");
    expect(onDeleted).not.toHaveBeenCalled();
    await waitFor(() => expect(mockDeleteSession).toHaveBeenCalledTimes(1));
  });
});
