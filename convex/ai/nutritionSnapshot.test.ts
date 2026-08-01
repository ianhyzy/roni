import { describe, expect, test } from "vitest";
import { formatNutritionSnapshot } from "./nutritionSnapshot";

describe("formatNutritionSnapshot", () => {
  test("formats partial user-reported days and self-set targets without inference", () => {
    const section = formatNutritionSnapshot({
      nutrition: {
        days: [
          {
            calendarDate: "2026-07-30",
            caloriesKcal: 0,
            proteinGrams: 160,
            updatedAt: 1,
          },
          {
            calendarDate: "2026-07-29",
            carbsGrams: 225.5,
            fatGrams: 70,
            updatedAt: 1,
          },
        ],
        targets: { caloriesKcal: 2_400, proteinGrams: 180 },
      },
      now: new Date("2026-07-30T18:00:00.000Z"),
      userTimezone: "America/Denver",
    });

    expect(section?.priority).toBe(6);
    expect(section?.lines).toEqual([
      "Nutrition (user-reported):",
      "  Targets (self-set): 2,400 kcal | 180g protein",
      "  [TODAY] 2026-07-30 | 0 kcal | 160g protein",
      "  [YESTERDAY] 2026-07-29 | 225.5g carbs | 70g fat",
      "  user-reported estimates; missing days/metrics are unknown, not zero; use only for general fueling/recovery context; do not diagnose deficiencies or give medical/dietetic advice.",
    ]);
    const text = section?.lines.join("\n") ?? "";
    expect(text).not.toContain("0g carbs");
    expect(text).not.toContain("deficit");
    expect(text).not.toContain("surplus");
  });

  test("omits days without visible metrics but keeps valid target context", () => {
    const section = formatNutritionSnapshot({
      nutrition: {
        days: [{ calendarDate: "2026-07-30", updatedAt: 1 }],
        targets: { fatGrams: 70 },
      },
      now: new Date("2026-07-30T18:00:00.000Z"),
    });

    expect(section?.lines).toContain("  Targets (self-set): 70g fat");
    expect(section?.lines.join("\n")).not.toContain("2026-07-30");
  });

  test("formats supplied day metrics when no targets are available", () => {
    const section = formatNutritionSnapshot({
      nutrition: {
        days: [{ calendarDate: "2026-07-30", proteinGrams: 155, updatedAt: 1 }],
        targets: null,
      },
      now: new Date("2026-07-30T18:00:00.000Z"),
      userTimezone: "America/Denver",
    });

    expect(section?.lines).toContain("  [TODAY] 2026-07-30 | 155g protein");
    expect(section?.lines.join("\n")).not.toContain("Targets (self-set)");
  });

  test("returns null when no nutrition metrics are available", () => {
    expect(
      formatNutritionSnapshot({
        nutrition: { days: [], targets: null },
        now: new Date("2026-07-30T18:00:00.000Z"),
      }),
    ).toBeNull();
  });
});
