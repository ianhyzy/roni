import { spawnSync } from "node:child_process";

const CONVEX_ENV_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const CONVEX_ENV_NAMES_OUTPUT = /^(?:[A-Za-z][A-Za-z0-9_]*\r?\n)*$/;
const INVALID_CONVEX_ENV_OUTPUT =
  "npx convex env list returned an unexpected format; setup cannot safely inspect the deployment.";

/**
 * List names without asking the CLI to print unrelated secret values.
 * Requiring a complete newline-terminated stream catches truncated or foreign
 * output instead of silently returning a partial view of the deployment.
 */
export function listConvexEnvNames(): Set<string> {
  const result = spawnSync("npx", ["convex", "env", "list", "--names-only"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(`npx convex env list failed (exit ${result.status}).`);
  }

  if (!CONVEX_ENV_NAMES_OUTPUT.test(result.stdout)) {
    throw new Error(INVALID_CONVEX_ENV_OUTPUT);
  }

  if (!result.stdout) return new Set();
  return new Set(result.stdout.split(/\r?\n/).slice(0, -1));
}

/** Read only the values that final setup validation needs to inspect. */
export function readConvexEnv(namesToRead: readonly string[]): Map<string, string> {
  if (namesToRead.some((name) => !CONVEX_ENV_NAME.test(name))) {
    throw new Error("Invalid Convex environment variable name requested by setup.");
  }

  const existingNames = listConvexEnvNames();
  const entries = new Map<string, string>();
  for (const name of new Set(namesToRead)) {
    if (!existingNames.has(name)) continue;
    const result = spawnSync("npx", ["convex", "env", "get", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new Error(`npx convex env get ${name} failed (exit ${result.status}).`);
    }
    if (!result.stdout.endsWith("\n")) {
      throw new Error(
        `npx convex env get ${name} returned an unexpected format; setup cannot safely inspect the value.`,
      );
    }
    entries.set(name, result.stdout.slice(0, -1));
  }
  return entries;
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
