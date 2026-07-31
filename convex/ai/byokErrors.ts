import type { Agent } from "@convex-dev/agent";
import {
  APICallError,
  type LanguageModelV3,
  type LanguageModelV3Middleware,
  type LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { getProviderConfig, type ProviderId } from "./providers";
import { classifyTransientError, type TransientErrorKind } from "./transientErrors";

const SETTINGS_LINK = "[Settings](/settings)";

export type ByokErrorCode =
  "byok_key_invalid" | "byok_quota_exceeded" | "byok_safety_blocked" | "byok_unknown_error";

export interface ProviderErrorCapture {
  wrapModel(model: LanguageModelV3): LanguageModelV3;
  reset(): void;
  consume(): Error | undefined;
}

const capturesByAgent = new WeakMap<Agent, ProviderErrorCapture>();

export function buildByokErrorMessage(code: ByokErrorCode, provider: ProviderId): string {
  const config = getProviderConfig(provider);
  const billingLink = `[${config.label} billing](${config.billingUrl})`;
  switch (code) {
    case "byok_key_invalid":
      return `**${config.label} rejected your API key.** Check or replace it in ${SETTINGS_LINK}, then try again.`;
    case "byok_quota_exceeded":
      return `**${config.label} is rejecting requests** — your account is out of credit or over quota. Top up at ${billingLink}, or switch providers in ${SETTINGS_LINK}, then try again.`;
    case "byok_safety_blocked":
      return `**${config.label} blocked that response for safety.** Try rephrasing and sending again.`;
    case "byok_unknown_error":
      return `**${config.label} returned an unexpected error.** Check your key in ${SETTINGS_LINK} or try again later.`;
  }
}

// Vercel AI SDK wraps provider errors: .message is generic, the real text
// lives on .responseBody / .cause.message. Pattern-match across all of them.
function gatherErrorText(error: Error): string {
  const parts: string[] = [error.message];
  if ("responseBody" in error && typeof error.responseBody === "string") {
    parts.push(error.responseBody);
  }
  if ("cause" in error && error.cause instanceof Error) {
    parts.push(error.cause.message);
  }
  if ("data" in error && error.data && typeof error.data === "object") {
    parts.push(JSON.stringify(error.data));
  }
  return parts.join(" ").toLowerCase();
}

export function classifyByokError(error: unknown): ByokErrorCode | null {
  if (!(error instanceof Error)) return null;

  switch (error.message) {
    case "byok_key_invalid":
    case "byok_quota_exceeded":
    case "byok_safety_blocked":
    case "byok_unknown_error":
      return error.message;
  }

  // APICallError exposes a typed statusCode; fall back to ad-hoc `.status`
  // on bare errors (raw fetch, provider SDKs that don't wrap in APICallError).
  const status = APICallError.isInstance(error)
    ? error.statusCode
    : (error as Error & { status?: number }).status;
  const lower = gatherErrorText(error);

  if (status === 401 || status === 403) return "byok_key_invalid";
  if (
    lower.includes("api key not valid") ||
    lower.includes("api_key_invalid") ||
    lower.includes("authentication_error") ||
    lower.includes("invalid_api_key") ||
    lower.includes("incorrect api key")
  ) {
    return "byok_key_invalid";
  }

  if (status === 429) return "byok_quota_exceeded";
  if (
    lower.includes("resource_exhausted") ||
    lower.includes("quota") ||
    lower.includes("rate_limit_error") ||
    lower.includes("rate_limit_exceeded") ||
    lower.includes("credits are depleted") ||
    lower.includes("credit balance") ||
    lower.includes("insufficient_quota") ||
    lower.includes("billing")
  ) {
    return "byok_quota_exceeded";
  }

  if (
    lower.includes("safety") ||
    lower.includes("blocked") ||
    lower.includes("content_policy") ||
    lower.includes("output_blocked") ||
    lower.includes("content_policy_violation")
  ) {
    return "byok_safety_blocked";
  }

  return null;
}

export function createProviderErrorCapture(): ProviderErrorCapture {
  let captured: Error | undefined;
  const reset = () => {
    captured = undefined;
  };
  const capture = (error: unknown): Error => {
    captured ??= toSafeCapturedError(error);
    return captured;
  };
  const middleware: LanguageModelV3Middleware = {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate }) => {
      reset();
      try {
        const result = await doGenerate();
        reset();
        return result;
      } catch (error) {
        throw capture(error);
      }
    },
    wrapStream: async ({ doStream }) => {
      reset();
      try {
        const result = await doStream();
        const reader = result.stream.getReader();
        let sawError = false;
        const stream = new ReadableStream<LanguageModelV3StreamPart>({
          async pull(controller) {
            try {
              const part = await reader.read();
              if (part.done) {
                if (!sawError) reset();
                controller.close();
                return;
              }
              if (part.value.type === "error") {
                sawError = true;
                controller.enqueue({ ...part.value, error: capture(part.value.error) });
                return;
              }
              controller.enqueue(part.value);
            } catch (error) {
              sawError = true;
              controller.error(capture(error));
            }
          },
          cancel: (reason) => reader.cancel(reason),
        });
        return { ...result, stream };
      } catch (error) {
        throw capture(error);
      }
    },
  };
  return {
    wrapModel: (model) => wrapLanguageModel({ model, middleware }),
    reset,
    consume: () => {
      const error = captured;
      reset();
      return error;
    },
  };
}

export function bindProviderErrorCapture(agent: Agent, capture: ProviderErrorCapture): void {
  capturesByAgent.set(agent, capture);
}

export function resetCapturedError(agent: Agent): void {
  capturesByAgent.get(agent)?.reset();
}

export function consumeCapturedError(agent: Agent): Error | undefined {
  return capturesByAgent.get(agent)?.consume();
}

function toSafeCapturedError(error: unknown): Error {
  const byokCode = classifyByokError(error);
  if (byokCode !== null) return new Error(byokCode);
  const transientKind = classifyTransientError(error);
  if (transientKind === null) return new Error("byok_unknown_error");
  return makeSafeTransientError(transientKind);
}

function makeSafeTransientError(kind: TransientErrorKind): Error {
  switch (kind) {
    case "provider_overload":
      return new Error("provider overloaded");
    case "rate_limit":
      return new Error("rate limit");
    case "context_limit":
      return new Error("input_token_count limit reached");
    case "timeout":
      return new Error("provider timeout");
    case "network":
      return new Error("read ECONNRESET");
    case "server_error":
      return Object.assign(new Error("server error"), { status: 500 });
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

// Google AI error bodies can echo the decrypted key — never rethrow raw.
export async function withByokErrorSanitization<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = classifyByokError(err);
    if (code !== null) throw new Error(code);
    throw err;
  }
}
