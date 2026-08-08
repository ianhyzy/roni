import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listConvexEnv, setConvexEnv } from "./convex";

const spawnResult = vi.hoisted(() => ({ status: 0, stderr: "", stdout: "" }));
const OPTION_LIKE_MULTILINE_VALUE = ["-----synthetic-option-like-value", "second-line"].join("\n");

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({
    pid: 1,
    output: [null, spawnResult.stdout, spawnResult.stderr],
    stdout: spawnResult.stdout,
    stderr: spawnResult.stderr,
    status: spawnResult.status,
    signal: null,
  })),
}));

describe("Convex setup CLI helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnResult.status = 0;
    spawnResult.stderr = "";
    spawnResult.stdout = "";
  });

  describe("listConvexEnv", () => {
    it("parses quoted multiline values from the Convex environment listing", () => {
      spawnResult.stdout = `JWT_PRIVATE_KEY='${OPTION_LIKE_MULTILINE_VALUE}'\nJWKS={"keys":[]}\n`;

      const env = listConvexEnv();

      expect(env.get("JWT_PRIVATE_KEY")).toBe(OPTION_LIKE_MULTILINE_VALUE);
      expect(env.get("JWKS")).toBe('{"keys":[]}');
    });

    it("parses the Convex formatter's double-quoted newline fallback", () => {
      spawnResult.stdout = `SYNTHETIC_VALUE="line one's\\nline two"\n`;

      const env = listConvexEnv();

      expect(env.get("SYNTHETIC_VALUE")).toBe("line one's\nline two");
    });

    it("parses environment names that start with a lowercase ASCII letter", () => {
      spawnResult.stdout = "lowercase_Name9=synthetic-lowercase-value\n";

      const env = listConvexEnv();

      expect(env.get("lowercase_Name9")).toBe("synthetic-lowercase-value");
    });

    it.each([
      ["an unexpected line", `JWKS={"keys":[]}\nsynthetic-unexpected-output\n`],
      ["an inline comment", `JWKS={"keys":[]} # synthetic-ignored-suffix\n`],
      ["an unterminated quote", `JWT_PRIVATE_KEY='synthetic-unclosed\nJWKS={"keys":[]}\n`],
      ["a name without a leading ASCII letter", `_SYNTHETIC=synthetic-invalid-name\n`],
    ])("rejects %s without exposing output", (_label, stdout) => {
      spawnResult.stdout = stdout;
      let errorMessage = "";

      try {
        listConvexEnv();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("unexpected format");
      expect(errorMessage).not.toContain("synthetic-");
    });

    it("does not expose CLI stderr when listing fails", () => {
      const secret = "synthetic-secret-that-must-not-leak";
      spawnResult.status = 1;
      spawnResult.stderr = `failure included ${secret}`;
      let errorMessage = "";

      try {
        listConvexEnv();
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toContain("npx convex env list failed (exit 1)");
      expect(errorMessage).not.toContain(secret);
    });
  });

  describe("setConvexEnv", () => {
    it("pipes multiline values through stdin instead of command arguments", () => {
      const value = `${OPTION_LIKE_MULTILINE_VALUE}\n`;

      setConvexEnv("JWT_PRIVATE_KEY", value);

      expect(spawnSync).toHaveBeenCalledWith("npx", ["convex", "env", "set", "JWT_PRIVATE_KEY"], {
        encoding: "utf8",
        input: value,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const commandArgs = vi.mocked(spawnSync).mock.calls.at(0)?.[1];
      expect(commandArgs).not.toContain(value);
    });

    it("does not expose a rejected secret in the error message", () => {
      const value = "secret-value-that-must-not-leak";
      spawnResult.status = 1;
      spawnResult.stderr = `provider echoed ${value}`;
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
});
