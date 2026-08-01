import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { NutritionDailyForm } from "./NutritionDailyForm";
import type { NutritionDailyLog } from "./nutritionForm";

const mockUpsertDaily = vi.fn();
const mockDeleteDaily = vi.fn();

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createDailyLog(overrides: Partial<NutritionDailyLog> = {}): NutritionDailyLog {
  return {
    calendarDate: "2026-07-30",
    source: "manual",
    caloriesKcal: 0,
    proteinGrams: 155,
    carbsGrams: null,
    fatGrams: 70,
    notes: "Evening meal",
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function renderForm(initialRow: NutritionDailyLog | null = null) {
  const onCalendarDateChange = vi.fn();
  const view = render(
    <NutritionDailyForm
      sourceKey={initialRow ? `2026-07-30:${initialRow.updatedAt}` : "2026-07-30:empty"}
      calendarDate="2026-07-30"
      initialRow={initialRow}
      onCalendarDateChange={onCalendarDateChange}
    />,
  );
  return { ...view, onCalendarDateChange };
}

vi.mock("convex/react", () => ({
  useMutation: (ref: string) => {
    if (ref === "nutrition:upsertDailyMine") return mockUpsertDaily;
    if (ref === "nutrition:deleteDailyMine") return mockDeleteDaily;
    throw new Error(`Unexpected mutation ${ref}`);
  },
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    nutrition: {
      deleteDailyMine: "nutrition:deleteDailyMine",
      upsertDailyMine: "nutrition:upsertDailyMine",
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

describe("NutritionDailyForm", () => {
  beforeEach(() => {
    mockUpsertDaily.mockReset();
    mockDeleteDaily.mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.success).mockReset();
  });

  it("creates a daily log with normalized metrics", async () => {
    const saved = createDailyLog({ proteinGrams: 160, fatGrams: null, notes: "Good fueling" });
    mockUpsertDaily.mockResolvedValueOnce(saved);
    renderForm();
    fireEvent.change(screen.getByLabelText("Calories (kcal)"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Protein (g)"), { target: { value: "160" } });
    fireEvent.change(screen.getByLabelText("Notes (optional)"), {
      target: { value: " Good fueling " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save log" }));

    await waitFor(() => {
      expect(mockUpsertDaily).toHaveBeenCalledWith({
        calendarDate: "2026-07-30",
        caloriesKcal: 0,
        proteinGrams: 160,
        notes: "Good fueling",
      });
    });
    expect(toast.success).toHaveBeenCalledWith("Nutrition log saved");
  });

  it("updates the loaded daily log", async () => {
    mockUpsertDaily.mockResolvedValueOnce(createDailyLog({ proteinGrams: 165 }));
    renderForm(createDailyLog());

    fireEvent.change(screen.getByLabelText("Protein (g)"), { target: { value: "165" } });
    fireEvent.click(screen.getByRole("button", { name: "Update log" }));

    await waitFor(() => {
      expect(mockUpsertDaily).toHaveBeenCalledWith({
        calendarDate: "2026-07-30",
        caloriesKcal: 0,
        proteinGrams: 165,
        fatGrams: 70,
        notes: "Evening meal",
      });
    });
    expect(toast.success).toHaveBeenCalledWith("Nutrition log updated");
  });

  it("reports the selected calendar date", () => {
    const { onCalendarDateChange } = renderForm();

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-07-29" } });

    expect(onCalendarDateChange).toHaveBeenCalledWith("2026-07-29");
  });

  it("locks duplicate save events while the mutation is pending", async () => {
    const save = createDeferred<NutritionDailyLog>();
    mockUpsertDaily.mockReturnValueOnce(save.promise);
    renderForm();
    fireEvent.change(screen.getByLabelText("Protein (g)"), { target: { value: "160" } });
    const form = screen.getByRole("button", { name: "Save log" }).closest("form");
    if (!form) throw new Error("Expected the nutrition daily form");

    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });

    expect(mockUpsertDaily).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Saving log" })).toBeDisabled();
    await act(async () => save.resolve(createDailyLog({ proteinGrams: 160 })));
  });

  it("restores the save action and focuses a backend error", async () => {
    mockUpsertDaily.mockRejectedValueOnce(new Error("Nutrition service unavailable"));
    renderForm();
    fireEvent.change(screen.getByLabelText("Protein (g)"), { target: { value: "160" } });

    fireEvent.click(screen.getByRole("button", { name: "Save log" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Nutrition service unavailable");
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.getByRole("button", { name: "Save log" })).toBeEnabled();
    expect(toast.error).toHaveBeenCalledWith("Nutrition service unavailable");
  });

  it("deletes the confirmed date without allowing a conflicting save", async () => {
    const deletion = createDeferred<null>();
    mockDeleteDaily.mockReturnValueOnce(deletion.promise);
    renderForm(createDailyLog());
    const updateButton = screen.getByRole("button", { name: "Update log" });
    fireEvent.click(screen.getByRole("button", { name: "Delete log" }));

    expect(
      screen.getByRole("heading", { name: "Delete the nutrition log for 2026-07-30?" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete log" }));

    expect(mockDeleteDaily).toHaveBeenCalledWith({ calendarDate: "2026-07-30" });
    const pendingDelete = screen.getByRole("button", { name: "Deleting log" });
    expect(pendingDelete).toBeDisabled();
    expect(updateButton).toBeDisabled();
    fireEvent.click(pendingDelete);
    fireEvent.click(updateButton);
    expect(mockDeleteDaily).toHaveBeenCalledTimes(1);
    expect(mockUpsertDaily).not.toHaveBeenCalled();

    await act(async () => deletion.resolve(null));

    expect(toast.success).toHaveBeenCalledWith("Nutrition log deleted");
    expect(screen.getByLabelText("Calories (kcal)")).toHaveValue(null);
    expect(
      screen.queryByRole("heading", { name: /Delete the nutrition log/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps confirmation open and reports a rejected deletion", async () => {
    mockDeleteDaily.mockRejectedValueOnce(new Error("Delete unavailable"));
    renderForm(createDailyLog());
    fireEvent.click(screen.getByRole("button", { name: "Delete log" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete log" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Delete unavailable");
    expect(
      screen.getByRole("heading", { name: "Delete the nutrition log for 2026-07-30?" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete log" })).toBeEnabled();
    expect(toast.error).toHaveBeenCalledWith("Delete unavailable");
  });
});
