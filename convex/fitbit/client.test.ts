import { describe, expect, it } from "vitest";
import { FITBIT_READ_SCOPES } from "./config";
import {
  buildDataPointsUrl,
  collectDataPointPages,
  createFitbitListBudget,
  fitbitDataTypesForScopes,
  googleForbiddenReason,
  parseDataPointsResponse,
  parseRefreshTokenResponse,
} from "./client";

describe("Google Health client helpers", () => {
  it("preserves the encrypted refresh-token source when Google does not rotate it", () => {
    expect(
      parseRefreshTokenResponse(
        {
          access_token: "access-2",
          expires_in: 3600,
          token_type: "Bearer",
        },
        "refresh-1",
        [...FITBIT_READ_SCOPES],
      ),
    ).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-1",
      expiresInSeconds: 3600,
      scopes: [...FITBIT_READ_SCOPES],
    });
  });

  it("accepts a rotated partial-consent scope set", () => {
    expect(
      parseRefreshTokenResponse(
        {
          access_token: "access-2",
          expires_in: 3600,
          token_type: "Bearer",
          scope: FITBIT_READ_SCOPES.slice(0, 2).join(" "),
        },
        "refresh-1",
        [...FITBIT_READ_SCOPES],
      ).scopes,
    ).toEqual(FITBIT_READ_SCOPES.slice(0, 2));
  });

  it("rejects a refresh with zero supported read scopes", () => {
    expect(() =>
      parseRefreshTokenResponse(
        {
          access_token: "access-2",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "openid email",
        },
        "refresh-1",
        [...FITBIT_READ_SCOPES],
      ),
    ).toThrow("Google OAuth refresh granted no supported Fitbit read scopes");
  });

  it("plans only data types covered by granted scopes", () => {
    expect(fitbitDataTypesForScopes([FITBIT_READ_SCOPES[1]])).toEqual([
      "daily-resting-heart-rate",
      "daily-heart-rate-variability",
    ]);
    expect(fitbitDataTypesForScopes([FITBIT_READ_SCOPES[0]])).toEqual(["exercise"]);
  });

  it("classifies only structured MISSING_OAUTH_SCOPE as consent loss", () => {
    expect(
      googleForbiddenReason({
        error: {
          details: [
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "MISSING_OAUTH_SCOPE" },
          ],
        },
      }),
    ).toBe("MISSING_OAUTH_SCOPE");
    expect(googleForbiddenReason({ error: { details: [{ reason: "DATA_ACCESS_DENIED" }] } })).toBe(
      "DATA_ACCESS_DENIED",
    );
    expect(googleForbiddenReason({ error: "malformed" })).toBeNull();
  });

  it("builds a bounded list URL with the documented filter and page token", () => {
    const url = new URL(
      buildDataPointsUrl({
        dataType: "sleep",
        filter: 'sleep.interval.civil_end_time >= "2026-07-01"',
        pageToken: "page-2",
      }),
    );

    expect(url.pathname).toBe("/v4/users/me/dataTypes/sleep/dataPoints");
    expect(url.searchParams.get("pageSize")).toBe("25");
    expect(url.searchParams.get("pageToken")).toBe("page-2");
    expect(url.searchParams.get("filter")).toBe('sleep.interval.civil_end_time >= "2026-07-01"');
  });

  it("fails closed on malformed list responses", () => {
    expect(() => parseDataPointsResponse({ dataPoints: "not-an-array" })).toThrow(
      "Malformed Google Health data-points response",
    );
  });

  it("fails closed instead of reporting success when pagination is truncated", async () => {
    await expect(
      collectDataPointPages(
        async (pageToken) => ({
          dataPoints: [{ name: pageToken ?? "first", dataSource: { platform: "FITBIT" } }],
          nextPageToken: pageToken === undefined ? "page-2" : "page-3",
        }),
        2,
      ),
    ).rejects.toThrow("Google Health pagination exceeded the bounded page limit");
  });

  it("rejects a repeated pagination token instead of fetching the same page forever", async () => {
    await expect(
      collectDataPointPages(async () => ({
        dataPoints: [],
        nextPageToken: "repeated-page",
      })),
    ).rejects.toThrow("Google Health returned a repeated page token");
  });

  it("shares one bounded page budget across data-type lists", async () => {
    const budget = createFitbitListBudget();
    budget.remainingPages = 2;

    await collectDataPointPages(async () => ({ dataPoints: [] }), 1, budget);
    await collectDataPointPages(async () => ({ dataPoints: [] }), 1, budget);

    await expect(
      collectDataPointPages(async () => ({ dataPoints: [] }), 1, budget),
    ).rejects.toThrow("Google Health pagination exceeded the aggregate page budget");
  });

  it("creates one 24-page budget covering four minutes", () => {
    const budget = createFitbitListBudget(1_000);

    expect(budget).toEqual({
      deadlineAt: 4 * 60 * 1_000 + 1_000,
      remainingPages: 24,
    });
  });

  it("fails closed when the aggregate request time budget is exhausted", async () => {
    const budget = createFitbitListBudget();
    budget.deadlineAt = Date.now() - 1;

    await expect(
      collectDataPointPages(async () => ({ dataPoints: [] }), 1, budget),
    ).rejects.toThrow("Google Health aggregate request time budget exceeded");
  });
});
