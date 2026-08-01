import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { Id } from "../../../convex/_generated/dataModel";
import { LiftingSessionForm } from "./LiftingSessionForm";
import type { LiftingSessionDraft, LiftingSessionSummary, LiftingSetDraft } from "./liftingForm";

const mockSaveSession = vi.fn();

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createSet(clientId: string, reps = "5", weightLbs = "185"): LiftingSetDraft {
  return { clientId, kind: "working", reps, weightLbs, rpe: "8" };
}

function createDraft(overrides: Partial<LiftingSessionDraft> = {}): LiftingSessionDraft {
  return {
    title: "Evening strength",
    performedDate: "2026-07-30",
    performedTime: "18:45",
    durationMinutes: "",
    notes: "",
    exercises: [
      {
        clientId: "exercise-squat",
        name: "Back squat",
        sets: [createSet("set-squat")],
      },
    ],
    ...overrides,
  };
}

function createSummary(): LiftingSessionSummary {
  return {
    sessionId: "lifting-session-1" as Id<"liftingSessions">,
    source: "manual",
    performedAt: new Date(2026, 6, 30, 18, 45).getTime(),
    calendarDate: "2026-07-30",
    title: "Evening strength",
    durationMinutes: null,
    notes: null,
    exerciseCount: 1,
    setCount: 1,
    totalReps: 5,
    totalVolumeLbs: 925,
    createdAt: 100,
    updatedAt: 100,
  };
}

vi.mock("convex/react", () => ({
  useMutation: (ref: string) => {
    if (ref === "liftingSessions:saveMine") return mockSaveSession;
    throw new Error(`Unexpected mutation ${ref}`);
  },
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    liftingSessions: {
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

describe("LiftingSessionForm", () => {
  beforeEach(() => {
    mockSaveSession.mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  it("adds and removes exercises and sets", () => {
    render(
      <LiftingSessionForm
        initialDraft={createDraft()}
        target={{ kind: "create" }}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add exercise" }));

    expect(screen.getAllByLabelText("Exercise name")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove exercise 2" }));
    expect(screen.getAllByLabelText("Exercise name")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Add set" }));
    expect(screen.getByRole("group", { name: /Set 2\s*for exercise 1/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove set 2 from exercise 1" }));
    expect(screen.queryByRole("group", { name: /Set 2\s*for exercise 1/ })).not.toBeInTheDocument();
  });

  it("keeps the intended exercise row when removing a middle exercise", () => {
    render(
      <LiftingSessionForm
        initialDraft={createDraft({
          exercises: [
            {
              clientId: "exercise-squat",
              name: "Back squat",
              sets: [createSet("set-squat")],
            },
            {
              clientId: "exercise-bench",
              name: "Bench press",
              sets: [createSet("set-bench", "6", "135")],
            },
            {
              clientId: "exercise-deadlift",
              name: "Deadlift",
              sets: [createSet("set-deadlift", "3", "225")],
            },
          ],
        })}
        target={{ kind: "create" }}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const deadliftInput = screen.getByDisplayValue("Deadlift");
    deadliftInput.focus();

    fireEvent.click(screen.getByRole("button", { name: "Remove exercise 2" }));

    expect(screen.getAllByLabelText("Exercise name")).toHaveLength(2);
    expect(
      screen.getAllByLabelText("Exercise name").map((input) => input.getAttribute("value")),
    ).toEqual(["Back squat", "Deadlift"]);
    expect(deadliftInput).toHaveFocus();
  });

  it("submits a normalized create mutation payload", async () => {
    const saved = createSummary();
    const onSaved = vi.fn();
    mockSaveSession.mockResolvedValueOnce(saved);
    render(
      <LiftingSessionForm
        initialDraft={createDraft()}
        target={{ kind: "create" }}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText("Session title"), {
      target: { value: " Evening strength " },
    });
    fireEvent.change(screen.getByLabelText("Notes (optional)"), {
      target: { value: " Strong finish " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));

    await waitFor(() => {
      expect(mockSaveSession).toHaveBeenCalledWith({
        input: {
          kind: "create",
          session: {
            performedAt: new Date(2026, 6, 30, 18, 45).getTime(),
            calendarDate: "2026-07-30",
            title: "Evening strength",
            notes: "Strong finish",
            exercises: [
              {
                name: "Back squat",
                sets: [{ kind: "working", reps: 5, weightLbs: 185, rpe: 8 }],
              },
            ],
          },
        },
      });
    });
    expect(onSaved).toHaveBeenCalledWith(saved);
    expect(toast.success).toHaveBeenCalledWith("Lifting session saved");
  });

  it("shows a visible validation error before calling the mutation", () => {
    render(
      <LiftingSessionForm
        initialDraft={createDraft({ title: "   " })}
        target={{ kind: "create" }}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save session" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Title must be between 1 and 100 characters.",
    );
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it("disables duplicate submission while a save is pending", async () => {
    const save = createDeferred<LiftingSessionSummary>();
    const onSaved = vi.fn();
    mockSaveSession.mockReturnValueOnce(save.promise);
    render(
      <LiftingSessionForm
        initialDraft={createDraft()}
        target={{ kind: "create" }}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save session" }));

    const pendingButton = screen.getByRole("button", { name: "Saving session" });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute("aria-busy", "true");
    fireEvent.click(pendingButton);
    expect(mockSaveSession).toHaveBeenCalledTimes(1);

    await act(async () => save.resolve(createSummary()));

    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("submits once when two submit events happen in the same turn", async () => {
    const save = createDeferred<LiftingSessionSummary>();
    mockSaveSession.mockReturnValue(save.promise);
    render(
      <LiftingSessionForm
        initialDraft={createDraft()}
        target={{ kind: "create" }}
        onCancel={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const form = screen.getByRole("button", { name: "Save session" }).closest("form");
    if (!form) throw new Error("Expected the lifting session form");

    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    expect(mockSaveSession).toHaveBeenCalledTimes(1);
    await act(async () => save.resolve(createSummary()));
  });

  it("shows a mutation error and restores the save action", async () => {
    const onSaved = vi.fn();
    mockSaveSession.mockRejectedValueOnce(new Error("Service unavailable"));
    render(
      <LiftingSessionForm
        initialDraft={createDraft()}
        target={{ kind: "create" }}
        onCancel={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Service unavailable");
    expect(screen.getByRole("button", { name: "Save session" })).toBeEnabled();
    expect(toast.error).toHaveBeenCalledWith("Service unavailable");
    expect(onSaved).not.toHaveBeenCalled();
  });
});
