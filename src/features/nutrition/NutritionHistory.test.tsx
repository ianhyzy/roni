import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NutritionHistory } from "./NutritionHistory";
import type { NutritionDailyLog } from "./nutritionForm";

function createDailyLog(overrides: Partial<NutritionDailyLog> = {}): NutritionDailyLog {
  return {
    calendarDate: "2026-07-30",
    source: "manual",
    caloriesKcal: 0,
    proteinGrams: null,
    carbsGrams: null,
    fatGrams: null,
    notes: null,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

describe("NutritionHistory", () => {
  it("shows an empty history state", () => {
    render(<NutritionHistory rows={[]} selectedDate="2026-07-30" onSelectDate={vi.fn()} />);

    expect(screen.getByText("No nutrition logs yet")).toBeVisible();
    expect(screen.getByText(/record your first day/i)).toBeVisible();
  });

  it("renders explicit zero separately from entirely unknown metrics with semantic dates", () => {
    const { container } = render(
      <NutritionHistory
        rows={[
          createDailyLog(),
          createDailyLog({ calendarDate: "2026-07-29", caloriesKcal: null }),
        ]}
        selectedDate="2026-07-30"
        onSelectDate={vi.fn()}
      />,
    );

    expect(screen.getByText("0 kcal")).toBeVisible();
    expect(screen.getByText("Metrics not recorded")).toBeVisible();
    expect(container.querySelector('time[datetime="2026-07-30"]')).toBeVisible();
    expect(container.querySelector('time[datetime="2026-07-29"]')).toBeVisible();
  });

  it("marks the selected date and reports a history selection", () => {
    const onSelectDate = vi.fn();
    render(
      <NutritionHistory
        rows={[
          createDailyLog(),
          createDailyLog({ calendarDate: "2026-07-29", caloriesKcal: 2_100 }),
        ]}
        selectedDate="2026-07-30"
        onSelectDate={onSelectDate}
      />,
    );

    expect(screen.getByRole("button", { name: /0 kcal.*Editing/ })).toHaveAttribute(
      "aria-current",
      "date",
    );
    fireEvent.click(screen.getByRole("button", { name: /2,100 kcal.*Edit/ }));
    expect(onSelectDate).toHaveBeenCalledWith("2026-07-29");
  });
});
