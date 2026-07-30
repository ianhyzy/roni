import { describe, expect, it } from "vitest";
import {
  getWeekStartDateString,
  getWeekStartDateStringInTimezone,
  isValidWeekStartDateString,
} from "./weekPlans";
import { getDateStringInTimezone } from "./weekPlanHelpers";

describe("isValidWeekStartDateString", () => {
  it("accepts valid YYYY-MM-DD", () => {
    expect(isValidWeekStartDateString("2026-03-09")).toBe(true);
    expect(isValidWeekStartDateString("2025-01-01")).toBe(true);
  });

  it("rejects non-YYYY-MM-DD strings", () => {
    expect(isValidWeekStartDateString("not-a-date")).toBe(false);
    expect(isValidWeekStartDateString("03-09-2026")).toBe(false);
    expect(isValidWeekStartDateString("2026/03/09")).toBe(false);
  });

  it("rejects invalid calendar dates", () => {
    expect(isValidWeekStartDateString("2026-02-30")).toBe(false);
    expect(isValidWeekStartDateString("2026-13-01")).toBe(false);
  });
});

describe("getWeekStartDateString", () => {
  it("returns Monday for a Monday date", () => {
    const monday = new Date("2026-03-09T12:00:00Z");
    expect(getWeekStartDateString(monday)).toBe("2026-03-09");
  });

  it("returns previous Monday for a Wednesday", () => {
    const wednesday = new Date("2026-03-11T12:00:00Z");
    expect(getWeekStartDateString(wednesday)).toBe("2026-03-09");
  });

  it("returns Monday of the week containing a Sunday", () => {
    const sunday = new Date("2026-03-08T12:00:00Z");
    expect(getWeekStartDateString(sunday)).toBe("2026-03-02");
  });

  it("returns same week Monday for Saturday", () => {
    const saturday = new Date("2026-03-14T12:00:00Z");
    expect(getWeekStartDateString(saturday)).toBe("2026-03-09");
  });
});

describe("getWeekStartDateStringInTimezone", () => {
  it("uses the user's Sunday when UTC has already reached Monday", () => {
    const mondayInUtc = new Date("2026-03-09T01:00:00.000Z");

    expect(getWeekStartDateStringInTimezone(mondayInUtc, "America/Denver")).toBe("2026-03-02");
    expect(getWeekStartDateStringInTimezone(mondayInUtc, "UTC")).toBe("2026-03-09");
  });
});

describe("getDateStringInTimezone", () => {
  it("returns the local calendar date and falls back to UTC for invalid timezones", () => {
    const instant = new Date("2026-08-03T01:00:00.000Z");

    expect(getDateStringInTimezone(instant, "America/Los_Angeles")).toBe("2026-08-02");
    expect(getDateStringInTimezone(instant, "Not/A_Timezone")).toBe("2026-08-03");
  });
});
