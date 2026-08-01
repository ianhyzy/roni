import { describe, expect, it } from "vitest";
import {
  LOCAL_DEV_APP_ORIGIN,
  resolveAppOrigin,
  resolveFitbitAppOrigin,
  resolveStravaAppOrigin,
} from "./httpOrigin";

describe("resolveAppOrigin", () => {
  it("uses the Garmin post-OAuth redirect URL first", () => {
    expect(
      resolveAppOrigin({
        GARMIN_OAUTH_POST_REDIRECT_URL: "https://app.example.com/garmin/callback",
        SITE_URL: "https://fallback.example.com",
      }),
    ).toBe("https://app.example.com");
  });

  it("falls back to SITE_URL when the Garmin redirect URL is missing or malformed", () => {
    expect(
      resolveAppOrigin({
        GARMIN_OAUTH_POST_REDIRECT_URL: "not-a-url",
        SITE_URL: "https://roni.example.com/settings",
      }),
    ).toBe("https://roni.example.com");
    expect(resolveAppOrigin({ SITE_URL: "https://roni.example.com/settings" })).toBe(
      "https://roni.example.com",
    );
  });

  it("allows localhost fallback only outside production", () => {
    expect(resolveAppOrigin({ NODE_ENV: "development" })).toBe(LOCAL_DEV_APP_ORIGIN);
    expect(() => resolveAppOrigin({ NODE_ENV: "production" })).toThrow(
      "GARMIN_OAUTH_POST_REDIRECT_URL, SITE_URL, or VERCEL_URL must be configured",
    );
  });

  it("uses VERCEL_URL for preview deployments without redirect env vars", () => {
    expect(
      resolveAppOrigin({
        VERCEL_ENV: "preview",
        VERCEL_URL: "preview-roni.vercel.app",
      }),
    ).toBe("https://preview-roni.vercel.app");
  });

  it("fails closed for Vercel deployments without any usable origin", () => {
    expect(() => resolveAppOrigin({ VERCEL_ENV: "preview" })).toThrow(
      "GARMIN_OAUTH_POST_REDIRECT_URL, SITE_URL, or VERCEL_URL must be configured",
    );
  });

  it("fails closed for production Vercel deployments without any usable origin", () => {
    expect(() => resolveAppOrigin({ VERCEL_ENV: "production" })).toThrow(
      "GARMIN_OAUTH_POST_REDIRECT_URL, SITE_URL, or VERCEL_URL must be configured",
    );
  });
});

describe("resolveFitbitAppOrigin", () => {
  it("uses only the Fitbit-specific post-OAuth redirect before SITE_URL", () => {
    expect(
      resolveFitbitAppOrigin({
        FITBIT_GOOGLE_OAUTH_POST_REDIRECT_URL: "https://fitbit.example.com/settings",
        GARMIN_OAUTH_POST_REDIRECT_URL: "https://garmin.example.com/settings",
        SITE_URL: "https://fallback.example.com",
      }),
    ).toBe("https://fitbit.example.com");
  });

  it("never falls back to the Garmin redirect URL", () => {
    expect(
      resolveFitbitAppOrigin({
        FITBIT_GOOGLE_OAUTH_POST_REDIRECT_URL: "not-a-url",
        GARMIN_OAUTH_POST_REDIRECT_URL: "https://garmin.example.com/settings",
        SITE_URL: "https://roni.example.com/settings",
      }),
    ).toBe("https://roni.example.com");
  });

  it("prefers SITE_URL over Vercel and uses Vercel instead of Garmin as the final fallback", () => {
    expect(
      resolveFitbitAppOrigin({
        GARMIN_OAUTH_POST_REDIRECT_URL: "https://garmin.example.com/settings",
        SITE_URL: "https://site.example.com/settings",
        VERCEL_URL: "preview.example.vercel.app",
      }),
    ).toBe("https://site.example.com");
    expect(
      resolveFitbitAppOrigin({
        GARMIN_OAUTH_POST_REDIRECT_URL: "https://garmin.example.com/settings",
        VERCEL_URL: "preview.example.vercel.app",
      }),
    ).toBe("https://preview.example.vercel.app");
  });

  it("accepts only an absolute HTTP origin from configured redirects", () => {
    expect(
      resolveFitbitAppOrigin({
        FITBIT_GOOGLE_OAUTH_POST_REDIRECT_URL: "javascript:alert(1)",
        SITE_URL: "https://roni.example.com/settings",
      }),
    ).toBe("https://roni.example.com");
  });

  it("fails closed in production when no Fitbit app origin is configured", () => {
    expect(() => resolveFitbitAppOrigin({ NODE_ENV: "production" })).toThrow(
      "FITBIT_GOOGLE_OAUTH_POST_REDIRECT_URL, SITE_URL, or VERCEL_URL must be configured",
    );
  });

  it("uses the local origin in development when no configured origin is available", () => {
    expect(resolveFitbitAppOrigin({ NODE_ENV: "development" })).toBe(LOCAL_DEV_APP_ORIGIN);
  });
});

describe("resolveStravaAppOrigin", () => {
  it("uses only the Strava-specific post-OAuth redirect before SITE_URL", () => {
    expect(
      resolveStravaAppOrigin({
        STRAVA_OAUTH_POST_REDIRECT_URL: "https://strava.example.com/settings",
        FITBIT_GOOGLE_OAUTH_POST_REDIRECT_URL: "https://fitbit.example.com/settings",
        GARMIN_OAUTH_POST_REDIRECT_URL: "https://garmin.example.com/settings",
        SITE_URL: "https://fallback.example.com",
      }),
    ).toBe("https://strava.example.com");
  });

  it("never falls back to another provider redirect URL", () => {
    expect(
      resolveStravaAppOrigin({
        STRAVA_OAUTH_POST_REDIRECT_URL: "not-a-url",
        FITBIT_GOOGLE_OAUTH_POST_REDIRECT_URL: "https://fitbit.example.com/settings",
        GARMIN_OAUTH_POST_REDIRECT_URL: "https://garmin.example.com/settings",
        SITE_URL: "https://roni.example.com/settings",
      }),
    ).toBe("https://roni.example.com");
  });

  it("uses Vercel as the final configured fallback", () => {
    expect(
      resolveStravaAppOrigin({
        GARMIN_OAUTH_POST_REDIRECT_URL: "https://garmin.example.com/settings",
        VERCEL_URL: "preview.example.vercel.app",
      }),
    ).toBe("https://preview.example.vercel.app");
  });

  it("accepts only an absolute HTTP origin from configured redirects", () => {
    expect(
      resolveStravaAppOrigin({
        STRAVA_OAUTH_POST_REDIRECT_URL: "javascript:alert(1)",
        SITE_URL: "https://roni.example.com/settings",
      }),
    ).toBe("https://roni.example.com");
  });

  it("fails closed in production when no Strava app origin is configured", () => {
    expect(() => resolveStravaAppOrigin({ NODE_ENV: "production" })).toThrow(
      "STRAVA_OAUTH_POST_REDIRECT_URL, SITE_URL, or VERCEL_URL must be configured",
    );
  });

  it("uses the local origin in development when no configured origin is available", () => {
    expect(resolveStravaAppOrigin({ NODE_ENV: "development" })).toBe(LOCAL_DEV_APP_ORIGIN);
  });
});
