import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiToolPreviewMaxChars, resolveRuntimeEnvironment } from "./env";

let originalVercelEnv: string | undefined;
let originalOverride: string | undefined;

beforeEach(() => {
  originalVercelEnv = process.env.VERCEL_ENV;
  originalOverride = process.env.AI_TOOL_PREVIEW_MAX_CHARS;
  delete process.env.VERCEL_ENV;
  delete process.env.AI_TOOL_PREVIEW_MAX_CHARS;
});

afterEach(() => {
  if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = originalVercelEnv;
  if (originalOverride === undefined) delete process.env.AI_TOOL_PREVIEW_MAX_CHARS;
  else process.env.AI_TOOL_PREVIEW_MAX_CHARS = originalOverride;
});

describe("aiToolPreviewMaxChars", () => {
  it("returns the dev default when no env vars are set", () => {
    expect(aiToolPreviewMaxChars()).toBe(4096);
  });

  it("returns the prod default when VERCEL_ENV=production", () => {
    process.env.VERCEL_ENV = "production";

    expect(aiToolPreviewMaxChars()).toBe(1024);
  });

  it("honors AI_TOOL_PREVIEW_MAX_CHARS over the prod default", () => {
    process.env.VERCEL_ENV = "production";
    process.env.AI_TOOL_PREVIEW_MAX_CHARS = "256";

    expect(aiToolPreviewMaxChars()).toBe(256);
  });

  it("honors AI_TOOL_PREVIEW_MAX_CHARS over the dev default", () => {
    process.env.AI_TOOL_PREVIEW_MAX_CHARS = "8192";

    expect(aiToolPreviewMaxChars()).toBe(8192);
  });

  it("falls back to the environment default when the override is not a positive integer", () => {
    process.env.AI_TOOL_PREVIEW_MAX_CHARS = "not-a-number";

    expect(aiToolPreviewMaxChars()).toBe(4096);
  });

  it("falls back when the override is zero or negative", () => {
    process.env.AI_TOOL_PREVIEW_MAX_CHARS = "0";
    expect(aiToolPreviewMaxChars()).toBe(4096);

    process.env.AI_TOOL_PREVIEW_MAX_CHARS = "-50";
    expect(aiToolPreviewMaxChars()).toBe(4096);
  });
});

describe("resolveRuntimeEnvironment", () => {
  it("defaults to dev outside Vercel", () => {
    expect(resolveRuntimeEnvironment({})).toBe("dev");
  });

  it.each(["production", "prod"])("uses the explicit %s production marker", (value) => {
    expect(resolveRuntimeEnvironment({ roniEnvironment: value })).toBe("prod");
  });

  it.each(["development", "dev"])(
    "lets the explicit %s marker override Vercel production",
    (value) => {
      expect(
        resolveRuntimeEnvironment({
          roniEnvironment: value,
          vercelEnvironment: "production",
        }),
      ).toBe("dev");
    },
  );

  it("falls back to the Vercel marker when the explicit value is invalid", () => {
    expect(
      resolveRuntimeEnvironment({
        roniEnvironment: "staging",
        vercelEnvironment: "production",
      }),
    ).toBe("prod");
  });
});
