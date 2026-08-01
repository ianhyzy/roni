import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NutritionDailyLog, NutritionTargets } from "./nutritionForm";
import { NutritionTracker } from "./NutritionTracker";

const mockUseQuery = vi.fn<(ref: string, args: unknown) => unknown>();
const mockUpsertDaily = vi.fn();
const mockDeleteDaily = vi.fn();
const mockSetTargets = vi.fn();
const mockClearTargets = vi.fn();
let mockRows: readonly NutritionDailyLog[] | undefined;
let mockTargets: NutritionTargets | null | undefined;
let mockSelectedRow: NutritionDailyLog | null | undefined;

function createDailyLog(overrides: Partial<NutritionDailyLog> = {}): NutritionDailyLog {
  return {
    calendarDate: "2026-07-31",
    source: "manual",
    caloriesKcal: 2_200,
    proteinGrams: 155,
    carbsGrams: null,
    fatGrams: 70,
    notes: null,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function createTargets(overrides: Partial<NutritionTargets> = {}): NutritionTargets {
  return {
    source: "self_set",
    caloriesKcal: 2_400,
    proteinGrams: 180,
    carbsGrams: null,
    fatGrams: 75,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

vi.mock("convex/react", () => ({
  useMutation: (ref: string) => {
    if (ref === "nutrition:upsertDailyMine") return mockUpsertDaily;
    if (ref === "nutrition:deleteDailyMine") return mockDeleteDaily;
    if (ref === "nutrition:setTargetsMine") return mockSetTargets;
    if (ref === "nutrition:clearTargetsMine") return mockClearTargets;
    throw new Error(`Unexpected mutation ${ref}`);
  },
  useQuery: (ref: string, args: unknown) => mockUseQuery(ref, args),
}));

vi.mock("../../../convex/_generated/api", () => ({
  api: {
    nutrition: {
      clearTargetsMine: "nutrition:clearTargetsMine",
      deleteDailyMine: "nutrition:deleteDailyMine",
      getDailyMine: "nutrition:getDailyMine",
      getTargetsMine: "nutrition:getTargetsMine",
      listRecentMine: "nutrition:listRecentMine",
      setTargetsMine: "nutrition:setTargetsMine",
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

describe("NutritionTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 6, 31, 12, 0));
    mockRows = [];
    mockTargets = null;
    mockSelectedRow = null;
    mockUseQuery.mockReset();
    mockUseQuery.mockImplementation((ref) => {
      if (ref === "nutrition:listRecentMine") return mockRows;
      if (ref === "nutrition:getTargetsMine") return mockTargets;
      if (ref === "nutrition:getDailyMine") return mockSelectedRow;
      throw new Error(`Unexpected query ${ref}`);
    });
    mockUpsertDaily.mockReset();
    mockDeleteDaily.mockReset();
    mockSetTargets.mockReset();
    mockClearTargets.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders bounded loading states while both queries resolve", () => {
    mockRows = undefined;
    mockTargets = undefined;
    mockSelectedRow = undefined;

    render(<NutritionTracker />);

    expect(screen.getByRole("status", { name: "Loading daily nutrition log" })).toBeVisible();
    expect(screen.getByRole("status", { name: "Loading nutrition targets" })).toBeVisible();
    expect(screen.getByRole("status", { name: "Loading recent nutrition logs" })).toBeVisible();
    expect(mockUseQuery).toHaveBeenCalledWith("nutrition:listRecentMine", { limit: 31 });
    expect(mockUseQuery).toHaveBeenCalledWith("nutrition:getTargetsMine", {});
    expect(mockUseQuery).toHaveBeenCalledWith("nutrition:getDailyMine", {
      calendarDate: "2026-07-31",
    });
  });

  it("renders empty daily, target, and history states for the local date", () => {
    render(<NutritionTracker />);

    expect(screen.getByLabelText("Date")).toHaveValue("2026-07-31");
    expect(screen.getByRole("button", { name: "Save log" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save targets" })).toBeEnabled();
    expect(screen.getByText("No nutrition logs yet")).toBeVisible();
  });

  it("refreshes edited drafts when row and target source keys change", () => {
    mockRows = [createDailyLog({ updatedAt: 1, proteinGrams: 155 })];
    mockSelectedRow = createDailyLog({ updatedAt: 1, proteinGrams: 155 });
    mockTargets = createTargets({ updatedAt: 1, proteinGrams: 180 });
    const view = render(<NutritionTracker />);
    const dailyProtein = screen.getAllByLabelText("Protein (g)")[0];
    const targetProtein = screen.getAllByLabelText("Protein (g)")[1];
    fireEvent.change(dailyProtein, { target: { value: "999" } });
    fireEvent.change(targetProtein, { target: { value: "999" } });

    mockRows = [createDailyLog({ updatedAt: 2, proteinGrams: 165 })];
    mockSelectedRow = createDailyLog({ updatedAt: 2, proteinGrams: 165 });
    mockTargets = createTargets({ updatedAt: 2, proteinGrams: 185 });
    view.rerender(<NutritionTracker />);

    expect(dailyProtein).toHaveValue(165);
    expect(targetProtein).toHaveValue(185);
  });

  it("loads the selected history row and moves focus to the daily heading", async () => {
    const selectedHistoryRow = createDailyLog({
      calendarDate: "2026-07-30",
      proteinGrams: 150,
    });
    mockRows = [
      selectedHistoryRow,
      createDailyLog({ calendarDate: "2026-07-29", proteinGrams: 145 }),
    ];
    mockUseQuery.mockImplementation((ref, args) => {
      if (ref === "nutrition:listRecentMine") return mockRows;
      if (ref === "nutrition:getTargetsMine") return mockTargets;
      if (ref === "nutrition:getDailyMine") {
        return (args as { calendarDate: string }).calendarDate === selectedHistoryRow.calendarDate
          ? selectedHistoryRow
          : null;
      }
      throw new Error(`Unexpected query ${ref}`);
    });
    render(<NutritionTracker />);

    fireEvent.click(screen.getByRole("button", { name: /150 g protein.*Edit/ }));

    expect(screen.getByLabelText("Date")).toHaveValue("2026-07-30");
    expect(screen.getAllByLabelText("Protein (g)")[0]).toHaveValue(150);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Daily log" })).toHaveFocus());
  });

  it("loads an exact older date that is outside the recent-history window", () => {
    const olderRow = createDailyLog({
      calendarDate: "2025-01-01",
      proteinGrams: 135,
      notes: "Older saved log",
    });
    mockRows = [createDailyLog()];
    mockUseQuery.mockImplementation((ref, args) => {
      if (ref === "nutrition:listRecentMine") return mockRows;
      if (ref === "nutrition:getTargetsMine") return mockTargets;
      if (ref === "nutrition:getDailyMine") {
        return (args as { calendarDate: string }).calendarDate === olderRow.calendarDate
          ? olderRow
          : null;
      }
      throw new Error(`Unexpected query ${ref}`);
    });
    render(<NutritionTracker />);

    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2025-01-01" } });

    expect(screen.getAllByLabelText("Protein (g)")[0]).toHaveValue(135);
    expect(screen.getByLabelText("Notes (optional)")).toHaveValue("Older saved log");
  });
});
