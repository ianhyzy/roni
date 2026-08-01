import { describe, expect, it } from "vitest";
import {
  buildNutritionDailyInput,
  buildNutritionTargetsInput,
  createNutritionDailyDraft,
  createNutritionMetricDraft,
  getLocalCalendarDate,
  type NutritionDailyDraft,
  type NutritionDailyLog,
  type NutritionMetricDraft,
  type NutritionTargets,
} from "./nutritionForm";

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

function createDailyDraft(overrides: Partial<NutritionDailyDraft> = {}): NutritionDailyDraft {
  return {
    caloriesKcal: "",
    proteinGrams: "160",
    carbsGrams: "",
    fatGrams: "0",
    notes: " Good fueling ",
    ...overrides,
  };
}

function createMetricDraft(overrides: Partial<NutritionMetricDraft> = {}): NutritionMetricDraft {
  return {
    caloriesKcal: "",
    proteinGrams: "180",
    carbsGrams: "",
    fatGrams: "0",
    ...overrides,
  };
}

describe("nutritionForm", () => {
  it("formats a deterministic browser-local calendar date", () => {
    const localNow = new Date(2026, 6, 31, 23, 59, 59);

    expect(getLocalCalendarDate(localNow)).toBe("2026-07-31");
  });

  it("creates editable drafts from loaded daily logs and targets", () => {
    expect(createNutritionDailyDraft(createDailyLog())).toEqual({
      caloriesKcal: "0",
      proteinGrams: "155",
      carbsGrams: "",
      fatGrams: "70",
      notes: "Evening meal",
    });
    expect(createNutritionMetricDraft(createTargets())).toEqual({
      caloriesKcal: "2400",
      proteinGrams: "180",
      carbsGrams: "",
      fatGrams: "75",
    });
  });

  it("creates entirely blank daily drafts when no source entry exists", () => {
    const blankDraft = {
      caloriesKcal: "",
      proteinGrams: "",
      carbsGrams: "",
      fatGrams: "",
      notes: "",
    };

    expect(createNutritionDailyDraft(undefined)).toEqual(blankDraft);
    expect(createNutritionDailyDraft(null)).toEqual(blankDraft);
  });

  it("omits blank daily metrics while preserving explicit zero and trimmed notes", () => {
    const result = buildNutritionDailyInput("2026-07-30", createDailyDraft());

    expect(result).toEqual({
      status: "valid",
      input: {
        calendarDate: "2026-07-30",
        proteinGrams: 160,
        fatGrams: 0,
        notes: "Good fueling",
      },
    });
  });

  it("omits blank target metrics while preserving explicit zero", () => {
    const result = buildNutritionTargetsInput(createMetricDraft());

    expect(result).toEqual({
      status: "valid",
      input: { proteinGrams: 180, fatGrams: 0 },
    });
  });

  it("rejects a nonexistent calendar date", () => {
    const result = buildNutritionDailyInput("2026-02-30", createDailyDraft());

    expect(result).toEqual({ status: "invalid", message: "Choose a valid date." });
  });

  it.each([
    ["negative calories", { caloriesKcal: "-1" }, "Calories must be between 0 and 20000."],
    ["protein above its bound", { proteinGrams: "2000.1" }, "Protein must be between 0 and 2000."],
    [
      "nonfinite carbohydrates",
      { carbsGrams: "Infinity" },
      "Carbohydrates must be between 0 and 2000.",
    ],
  ])("rejects %s", (_caseName, metric, message) => {
    const result = buildNutritionDailyInput("2026-07-30", createDailyDraft(metric));

    expect(result).toEqual({ status: "invalid", message });
  });

  it("rejects notes above the maximum length", () => {
    const result = buildNutritionDailyInput(
      "2026-07-30",
      createDailyDraft({ notes: "n".repeat(501) }),
    );

    expect(result).toEqual({
      status: "invalid",
      message: "Notes must be 500 characters or fewer.",
    });
  });

  it("requires at least one metric for daily logs and targets", () => {
    const blankMetrics = createMetricDraft({
      caloriesKcal: " ",
      proteinGrams: "",
      carbsGrams: "",
      fatGrams: "",
    });

    expect(
      buildNutritionDailyInput("2026-07-30", { ...blankMetrics, notes: "notes alone" }),
    ).toEqual({ status: "invalid", message: "Enter at least one nutrition metric." });
    expect(buildNutritionTargetsInput(blankMetrics)).toEqual({
      status: "invalid",
      message: "Enter at least one nutrition metric.",
    });
  });
});
