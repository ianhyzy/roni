import { describe, expect, it } from "vitest";
import {
  EXTERNAL_ACTIVITY_SOURCE_VALUES,
  EXTERNAL_ACTIVITY_SOURCES,
  normalizeExternalActivitySource,
} from "./externalActivitySources";

describe("normalizeExternalActivitySource", () => {
  it("exposes the exact canonical source values", () => {
    expect(EXTERNAL_ACTIVITY_SOURCES).toEqual({
      APPLE_HEALTH: "appleHealth",
      FITBIT: "fitbit",
      GARMIN: "garmin",
      STRAVA: "strava",
      OTHER: "other",
    });
    expect(EXTERNAL_ACTIVITY_SOURCE_VALUES).toEqual([
      "appleHealth",
      "fitbit",
      "garmin",
      "strava",
      "other",
    ]);
  });

  it("normalizes canonical and legacy Fitbit source aliases", () => {
    expect(normalizeExternalActivitySource("fitbit")).toBe(EXTERNAL_ACTIVITY_SOURCES.FITBIT);
    expect(normalizeExternalActivitySource("Fitbit Web API")).toBe(
      EXTERNAL_ACTIVITY_SOURCES.FITBIT,
    );
    expect(normalizeExternalActivitySource(" FITBIT_WEB-API ")).toBe(
      EXTERNAL_ACTIVITY_SOURCES.FITBIT,
    );
  });

  it("normalizes canonical and API-labeled Strava sources", () => {
    expect(normalizeExternalActivitySource("strava")).toBe(EXTERNAL_ACTIVITY_SOURCES.STRAVA);
    expect(normalizeExternalActivitySource("Strava API")).toBe(EXTERNAL_ACTIVITY_SOURCES.STRAVA);
    expect(normalizeExternalActivitySource(" STRAVA_API ")).toBe(EXTERNAL_ACTIVITY_SOURCES.STRAVA);
    expect(normalizeExternalActivitySource("Strava Web API")).toBe(
      EXTERNAL_ACTIVITY_SOURCES.STRAVA,
    );
  });

  it("keeps unknown providers in the other source bucket", () => {
    expect(normalizeExternalActivitySource("Google Health Connect")).toBe(
      EXTERNAL_ACTIVITY_SOURCES.OTHER,
    );
  });
});
