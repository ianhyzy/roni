import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listConvexEnvNames, readConvexEnv, runConvexDevOnce, setConvexEnv } from "./convex";

const spawnResults = vi.hoisted(
  () => [] as Array<{ status: number; stderr: string; stdout: string }>,
);
const OPTION_LIKE_MULTILINE_VALUE = ["-----synthetic-option-like-value", "second-line"].join("\n");
const EXPECTED_CONVEX_CLI_PATH = path.join(
  path.dirname(createRequire(import.meta.url).resolve("convex/package.json")),
  "bin",
  "main.js",
);

function queueSpawnResult({
  status = 0,
  stderr = "",
  stdout = "",
}: Partial<(typeof spawnResults)[number]> = {}): void {
  spawnResults.push({ status, stderr, stdout });
}

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => {
    const result = spawnResults.shift() ?? { status: 0, stderr: "", stdout: "" };
    return {
      pid: 1,
      output: [null, result.stdout, result.stderr],
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.status,
      signal: null,
    };
  }),
}));

describe("Convex setup CLI helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnResults.length = 0;
  });

  describe("listConvexEnvNames", () => {
    it("accepts complete uppercase and lowercase ASCII environment names", () => {
      queueSpawnResult({ stdout: "JWT_PRIVATE_KEY\nlowercase_Name9\n" });

      const names = listConvexEnvNames();

      expect(names).toEqual(new Set(["JWT_PRIVATE_KEY", "lowercase_Name9"]));
      expect(spawnSync).toHaveBeenCalledWith(
        process.execPath,
        [EXPECTED_CONVEX_CLI_PATH, "env", "list", "--names-only"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    });

    it("returns an empty set when the deployment has no variables", () => {
      const names = listConvexEnvNames();

      expect(names).toEqual(new Set());
    });

    it.each([
      ["foreign output", "JWT_PRIVATE_KEY\nsynthetic-unexpected-output\n"],
      ["value-bearing output", "JWT_PRIVATE_KEY=synthetic-secret-value\n"],
      ["a truncated final line", "JWT_PRIVATE_KEY"],
      ["a name without a leading ASCII letter", "_SYNTHETIC\n"],
    ])("rejects %s without exposing output", (_label, stdout) => {
      queueSpawnResult({ stdout });
      let errorMessage = "";

      try {
        listConvexEnvNames();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("unexpected format");
      expect(errorMessage).not.toContain("synthetic-");
    });

    it("does not expose CLI output when listing fails", () => {
      const secret = "synthetic-secret-that-must-not-leak";
      queueSpawnResult({
        status: 1,
        stdout: `stdout included ${secret}`,
        stderr: `stderr included ${secret}`,
      });
      let errorMessage = "";

      try {
        listConvexEnvNames();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("npx convex env list failed (exit 1)");
      expect(errorMessage).not.toContain(secret);
    });
  });

  describe("readConvexEnv", () => {
    it("reads an unmatched quote-start value without parsing unrelated dotenv output", () => {
      // Convex 1.42.3's formatter deliberately emits unmatched quote-start values verbatim.
      queueSpawnResult({ stdout: "note\n" });
      queueSpawnResult({ stdout: '"starts\n' });

      const env = readConvexEnv(["note"]);

      expect(env.get("note")).toBe('"starts');
      expect(spawnSync).toHaveBeenNthCalledWith(
        1,
        process.execPath,
        [EXPECTED_CONVEX_CLI_PATH, "env", "list", "--names-only"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      expect(spawnSync).toHaveBeenNthCalledWith(
        2,
        process.execPath,
        [EXPECTED_CONVEX_CLI_PATH, "env", "get", "note"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    });

    it("strips only the CLI newline from a multiline required value", () => {
      const storedValue = `${OPTION_LIKE_MULTILINE_VALUE}\n`;
      queueSpawnResult({ stdout: "JWT_PRIVATE_KEY\n" });
      queueSpawnResult({ stdout: `${storedValue}\n` });

      const env = readConvexEnv(["JWT_PRIVATE_KEY"]);

      expect(env.get("JWT_PRIVATE_KEY")).toBe(storedValue);
    });

    it("does not fetch unrelated or missing environment values", () => {
      queueSpawnResult({ stdout: "UNRELATED_SECRET\nJWKS\n" });
      queueSpawnResult({ stdout: '{"keys":[]}\n' });

      const env = readConvexEnv(["JWKS", "MISSING_REQUIRED"]);

      expect(env).toEqual(new Map([["JWKS", '{"keys":[]}']]));
      expect(spawnSync).toHaveBeenCalledTimes(2);
      expect(
        vi.mocked(spawnSync).mock.calls.some((call) => call[1]?.includes("UNRELATED_SECRET")),
      ).toBe(false);
    });

    it("does not expose CLI output when reading a value fails", () => {
      const secret = "synthetic-secret-that-must-not-leak";
      queueSpawnResult({ stdout: "JWT_PRIVATE_KEY\n" });
      queueSpawnResult({
        status: 1,
        stdout: `stdout included ${secret}`,
        stderr: `stderr included ${secret}`,
      });
      let errorMessage = "";

      try {
        readConvexEnv(["JWT_PRIVATE_KEY"]);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("npx convex env get JWT_PRIVATE_KEY failed (exit 1)");
      expect(errorMessage).not.toContain(secret);
    });

    it("rejects a value response without the CLI newline without exposing it", () => {
      const secret = "synthetic-secret-that-must-not-leak";
      queueSpawnResult({ stdout: "JWT_PRIVATE_KEY\n" });
      queueSpawnResult({ stdout: secret });
      let errorMessage = "";

      try {
        readConvexEnv(["JWT_PRIVATE_KEY"]);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("unexpected format");
      expect(errorMessage).not.toContain(secret);
    });
  });

  describe("setConvexEnv", () => {
    it("pipes multiline values through stdin instead of command arguments", () => {
      const value = `${OPTION_LIKE_MULTILINE_VALUE}\n`;

      setConvexEnv("JWT_PRIVATE_KEY", value);

      const commandArgs = vi.mocked(spawnSync).mock.calls.at(0)?.[1];
      expect(commandArgs).not.toContain(value);
      const spawnOptions = vi.mocked(spawnSync).mock.calls.at(0)?.[2];
      const transportInput =
        spawnOptions && typeof spawnOptions === "object" && "input" in spawnOptions
          ? spawnOptions.input
          : undefined;
      expect(typeof transportInput).toBe("string");
      if (typeof transportInput !== "string") throw new Error("Expected string stdin input");
      expect(transportInput.replace(/\n$/, "")).toBe(value);
      expect(spawnSync).toHaveBeenCalledWith(
        process.execPath,
        [EXPECTED_CONVEX_CLI_PATH, "env", "set", "JWT_PRIVATE_KEY"],
        {
          encoding: "utf8",
          input: `${value}\n`,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    });

    it("does not expose a rejected secret in the error message", () => {
      const value = "secret-value-that-must-not-leak";
      queueSpawnResult({ status: 1, stderr: `provider echoed ${value}` });
      let errorMessage = "";

      try {
        setConvexEnv("API_KEY", value);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("npx convex env set API_KEY failed (exit 1)");
      expect(errorMessage).not.toContain(value);
    });
  });

  describe("runConvexDevOnce", () => {
    it("invokes the installed CLI through the current Node executable", () => {
      runConvexDevOnce();

      expect(spawnSync).toHaveBeenCalledWith(
        process.execPath,
        [EXPECTED_CONVEX_CLI_PATH, "dev", "--once"],
        { stdio: "inherit" },
      );
    });
  });
});
