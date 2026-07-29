import { describe, expect, it } from "vitest";
import { formatFitbitWellnessLines } from "./fitbitWellnessSnapshot";

describe("formatFitbitWellnessLines", () => {
  it("formats bounded Fitbit recovery signals for the coach", () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({
      calendarDate: `2026-07-${(28 - index).toString().padStart(2, "0")}`,
      sleepDurationSeconds: 7 * 3600 + index * 60,
      restingHeartRate: 54 + index,
      averageHrvMilliseconds: 46.5 - index,
    }));

    const lines = formatFitbitWellnessLines(rows);

    expect(lines[0]).toBe("Fitbit Recovery Signals:");
    expect(lines).toContain("  2026-07-28 | sleep 7h | RHR 54 | HRV 46.5ms");
    expect(lines.some((line) => line.includes("2026-07-21"))).toBe(false);
    expect(lines[lines.length - 1]).toContain("recovery or reduced volume");
  });

  it("omits an empty section", () => {
    expect(formatFitbitWellnessLines([{ calendarDate: "2026-07-28" }])).toEqual([]);
  });
});
