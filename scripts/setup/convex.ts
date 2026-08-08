import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

const CONVEX_ENV_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
// parseEnv silently skips malformed dotenv text, so validate the complete
// round-trippable `convex env list` stream before parsing it.
const CONVEX_ENV_LIST_OUTPUT =
  /^(?:[A-Za-z][A-Za-z0-9_]*=(?:'(?:[^'\r\n]|\r?\n)*'|"(?:[^"\r\n]|\r?\n)*"|(?!['"`])[^#\r\n]*)(?:\r?\n|$))*$/;
const INVALID_CONVEX_ENV_OUTPUT =
  "npx convex env list returned an unexpected format; setup cannot safely inspect the deployment.";

/**
 * Run `npx convex env list` and return a map of variable name -> value.
 * Parse the CLI's documented dotenv output as a whole so quoted multiline
 * values round-trip without exposing their continuation lines in errors.
 */
export function listConvexEnv(): Map<string, string> {
  const result = spawnSync("npx", ["convex", "env", "list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(`npx convex env list failed (exit ${result.status}).`);
  }

  if (!CONVEX_ENV_LIST_OUTPUT.test(result.stdout)) {
    throw new Error(INVALID_CONVEX_ENV_OUTPUT);
  }

  let entries: Array<[string, string]>;
  try {
    entries = [];
    for (const [key, value] of Object.entries(parseEnv(result.stdout))) {
      if (value === undefined) throw new Error(INVALID_CONVEX_ENV_OUTPUT);
      entries.push([key, value]);
    }
  } catch {
    throw new Error(INVALID_CONVEX_ENV_OUTPUT);
  }
  const hasUnexpectedOutput =
    (result.stdout.trim().length > 0 && entries.length === 0) ||
    entries.some(([key]) => !CONVEX_ENV_NAME.test(key));
  if (hasUnexpectedOutput) {
    throw new Error(INVALID_CONVEX_ENV_OUTPUT);
  }
  return new Map(entries);
}

/**
 * Set a single Convex environment variable.
 * Values go through stdin so option-like PEM content is not parsed as CLI flags
 * and secrets are not exposed in process arguments.
 * Throws on failure. Deliberately does NOT include stderr in the error
 * message because Convex CLI may echo the submitted value back on
 * validation errors, which would leak the secret into logs.
 */
export function setConvexEnv(key: string, value: string): void {
  const result = spawnSync("npx", ["convex", "env", "set", key], {
    encoding: "utf8",
    input: value,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(
      `npx convex env set ${key} failed (exit ${result.status}). ` +
        `Run 'npx convex env set ${key}' interactively to diagnose without putting the value in shell history.`,
    );
  }
}

/**
 * Run `npx convex dev --once` with inherited stdio so the user sees the
 * Convex CLI prompts and can log in / pick a project.
 */
export function runConvexDevOnce(): void {
  const result = spawnSync("npx", ["convex", "dev", "--once"], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(
      `npx convex dev --once failed (exit ${result.status}). ` +
        "Make sure you are logged in (npx convex login) and try again.",
    );
  }
}
