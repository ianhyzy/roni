import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { RecoveryCheckInCard } from "./RecoveryCheckInCard";

const mockUpsert = vi.fn();
let mockRows: unknown;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock("convex/react", () => ({
  useMutation: () => mockUpsert,
  useQuery: () => mockRows,
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    recoveryCheckIns: {
      listRecentMine: "recoveryCheckIns:listRecentMine",
      upsertMine: "recoveryCheckIns:upsertMine",
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("RecoveryCheckInCard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-30T12:00:00"));
    mockUpsert.mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();
    mockRows = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a non-interactive loading state until recovery rows arrive", () => {
    mockRows = undefined;

    render(<RecoveryCheckInCard />);

    expect(screen.getByRole("status", { name: "Loading recovery check-in" })).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("prefills the instrument from today's saved recovery row", () => {
    mockRows = [
      {
        calendarDate: "2026-07-30",
        energy: 4,
        soreness: 2,
        stress: 3,
        notes: "Ready for lower body work",
        createdAt: 100,
        updatedAt: 200,
      },
    ];

    render(<RecoveryCheckInCard />);

    expect(screen.getByRole("button", { name: "Energy 4 of 5" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Soreness 2 of 5" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Stress 3 of 5" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("Ready for lower body work");
    expect(screen.getByRole("button", { name: "Update today's recovery" })).toBeEnabled();
  });

  it("leaves an unexpected stored score unselected", () => {
    mockRows = [
      {
        calendarDate: "2026-07-30",
        energy: 0,
        soreness: 2,
        stress: 3,
        notes: null,
        createdAt: 100,
        updatedAt: 200,
      },
    ];

    render(<RecoveryCheckInCard />);

    for (const button of screen.getAllByRole("button", { name: /^Energy [1-5] of 5$/ })) {
      expect(button).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.getByRole("button", { name: "Update today's recovery" })).toBeDisabled();
  });

  it("saves an explicit local-date check-in and disables duplicate submission", async () => {
    const save = createDeferred<unknown>();
    mockUpsert.mockReturnValueOnce(save.promise);
    render(<RecoveryCheckInCard />);

    expect(screen.getByRole("button", { name: "Save today's recovery" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Energy 4 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Soreness 2 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Stress 3 of 5" }));
    fireEvent.change(screen.getByLabelText("Notes (optional)"), {
      target: { value: " Slept well " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save today's recovery" }));

    expect(mockUpsert).toHaveBeenCalledWith({
      calendarDate: "2026-07-30",
      energy: 4,
      soreness: 2,
      stress: 3,
      notes: " Slept well ",
    });
    const savingButton = screen.getByRole("button", { name: "Saving recovery" });
    expect(savingButton).toBeDisabled();
    expect(savingButton).toHaveAttribute("aria-busy", "true");
    fireEvent.click(savingButton);
    expect(mockUpsert).toHaveBeenCalledTimes(1);

    await act(async () => save.resolve({}));

    expect(toast.success).toHaveBeenCalledWith("Recovery check-in saved");
  });

  it("uses the browser-local date through the final second of the day", async () => {
    vi.setSystemTime(new Date(2026, 6, 30, 23, 59, 59));
    mockUpsert.mockResolvedValueOnce({});
    render(<RecoveryCheckInCard />);

    fireEvent.click(screen.getByRole("button", { name: "Energy 4 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Soreness 2 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Stress 3 of 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Save today's recovery" }));

    await waitFor(() => {
      expect(mockUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ calendarDate: "2026-07-30" }),
      );
    });
  });

  it("surfaces a save error and restores the form action", async () => {
    mockRows = [
      {
        calendarDate: "2026-07-30",
        energy: 3,
        soreness: 3,
        stress: 3,
        notes: null,
        createdAt: 100,
        updatedAt: 100,
      },
    ];
    mockUpsert.mockRejectedValueOnce(new Error("offline"));
    render(<RecoveryCheckInCard />);

    fireEvent.click(screen.getByRole("button", { name: "Update today's recovery" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Could not save recovery. Try again.");
    });
    expect(screen.getByRole("button", { name: "Update today's recovery" })).toBeEnabled();
  });

  it("renders the query-bounded recent self-report ledger separately from today", () => {
    mockRows = [
      {
        calendarDate: "2026-07-30",
        energy: 3,
        soreness: 3,
        stress: 3,
        notes: null,
        createdAt: 200,
        updatedAt: 200,
      },
      {
        calendarDate: "2026-07-29",
        energy: 5,
        soreness: 1,
        stress: 2,
        notes: "Fresh",
        createdAt: 100,
        updatedAt: 100,
      },
    ];

    render(<RecoveryCheckInCard />);

    expect(screen.getByRole("heading", { name: "Recent recovery" })).toBeVisible();
    expect(screen.getByText("Jul 29")).toBeVisible();
    expect(screen.getByText("E5 · S1 · T2")).toBeVisible();
    expect(screen.getByText("Fresh")).toBeVisible();
    expect(screen.queryByText("Jul 30")).not.toBeInTheDocument();
  });
});
