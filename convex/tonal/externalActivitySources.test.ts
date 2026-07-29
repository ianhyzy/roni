import { describe, expect, it } from "vitest";
import {
  EXTERNAL_ACTIVITY_SOURCES,
  normalizeExternalActivitySource,
} from "./externalActivitySources";

describe("normalizeExternalActivitySource", () => {
  it("normalizes canonical and legacy Fitbit source aliases", () => {
    expect(normalizeExternalActivitySource("fitbit")).toBe(EXTERNAL_ACTIVITY_SOURCES.FITBIT);
    expect(normalizeExternalActivitySource("Fitbit Web API")).toBe(
      EXTERNAL_ACTIVITY_SOURCES.FITBIT,
    );
    expect(normalizeExternalActivitySource(" FITBIT_WEB-API ")).toBe(
      EXTERNAL_ACTIVITY_SOURCES.FITBIT,
    );
  });

  it("keeps unknown providers in the other source bucket", () => {
    expect(normalizeExternalActivitySource("Google Health Connect")).toBe(
      EXTERNAL_ACTIVITY_SOURCES.OTHER,
    );
  });
});
