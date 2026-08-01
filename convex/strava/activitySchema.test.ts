import { describe, expect, it } from "vitest";
import { parsePublicStravaActivity, parsePublicStravaActivityList } from "./activitySchema";

function activity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123456789,
    athlete: { id: 987654321 },
    name: "Morning Run",
    type: "Run",
    sport_type: "TrailRun",
    start_date: "2026-07-30T12:00:00Z",
    start_date_local: "2026-07-30T06:00:00Z",
    timezone: "(GMT-07:00) America/Denver",
    distance: 5_000.5,
    moving_time: 1_800,
    elapsed_time: 1_920,
    total_elevation_gain: 125.5,
    achievement_count: 2,
    trainer: false,
    commute: false,
    manual: false,
    private: false,
    description: "must not survive projection",
    map: { summary_polyline: "must-not-survive" },
    ...overrides,
  };
}

describe("Strava activity response parsing", () => {
  it("projects only the approved public summary fields", () => {
    expect(parsePublicStravaActivity(activity())).toEqual({
      providerActivityId: "123456789",
      athleteId: "987654321",
      type: "Run",
      sportType: "TrailRun",
      name: "Morning Run",
      startDate: "2026-07-30T12:00:00Z",
      startDateLocal: "2026-07-30T06:00:00Z",
      timezone: "(GMT-07:00) America/Denver",
      distanceMeters: 5_000.5,
      movingTimeSeconds: 1_800,
      elapsedTimeSeconds: 1_920,
      elevationGainMeters: 125.5,
      achievementCount: 2,
      trainer: false,
      commute: false,
      manual: false,
      private: false,
    });
  });

  it("discards private activities from single and list responses", () => {
    expect(parsePublicStravaActivity(activity({ private: true }))).toBeNull();
    expect(
      parsePublicStravaActivityList([
        activity({ id: 1, private: true }),
        activity({ id: 2, name: "Public Ride" }),
      ]),
    ).toEqual([
      expect.objectContaining({ providerActivityId: "2", name: "Public Ride", private: false }),
    ]);
  });

  it.each([
    ["nullable provider field", { distance: null }],
    ["negative duration", { moving_time: -1 }],
    ["fractional count", { achievement_count: 1.5 }],
    ["unsafe provider id", { id: Number.MAX_SAFE_INTEGER + 1 }],
    ["invalid timestamp", { start_date: "not-a-date" }],
  ])("rejects %s", (_label, override) => {
    expect(() => parsePublicStravaActivity(activity(override))).toThrow();
  });

  it("rejects one malformed activity instead of accepting a partial list", () => {
    expect(() =>
      parsePublicStravaActivityList([activity({ id: 1 }), activity({ id: 2, trainer: "false" })]),
    ).toThrow();
  });
});
