# AI Model Policy

Last reviewed: 2026-08-08

This policy defines the default production model tiers used by the coach. The model-policy source of truth is `convex/ai/providers.ts`, and the pricing source of truth is `convex/ai/modelPricing.ts`. This document explains their intent, default model IDs, and standard pricing assumptions.

## Tiers

| Tier          | Purpose                                                                                                                 | Primary callers                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `router`      | Lowest-cost first pass for trivial acknowledgements and short local edits.                                              | Short prompts classified as `trivial`; fallback from default chat turns. |
| `chat`        | Default conversational coaching model.                                                                                  | Normal chat turns; fallback from programming turns.                      |
| `programming` | Highest-capability model for workout programming, plan edits, Tonal push/approval continuations, and complex tool work. | Prompts classified as `complex`; `continueAfterApproval`.                |
| `summarize`   | Low-cost summarization tier for future summary jobs.                                                                    | Not currently used by the chat loop.                                     |

Routing starts on one tier and falls back to another:

| Intent                  | Primary tier  | Fallback tier |
| ----------------------- | ------------- | ------------- |
| `trivial`               | `router`      | `chat`        |
| `default`               | `chat`        | `router`      |
| `complex`               | `programming` | `chat`        |
| `approval_continuation` | `programming` | `chat`        |

OpenRouter is the exception: all tiers use the selected OpenRouter model, and fallback remains `null` because OpenRouter handles routing and fallback internally.

## Defaults

| Provider   | `router`                | `chat`             | `programming`      | `summarize`             |
| ---------- | ----------------------- | ------------------ | ------------------ | ----------------------- |
| Gemini     | `gemini-3.5-flash-lite` | `gemini-3.6-flash` | `gemini-3.6-flash` | `gemini-3.5-flash-lite` |
| Claude     | `claude-haiku-4-5`      | `claude-sonnet-5`  | `claude-opus-5`    | `claude-haiku-4-5`      |
| OpenAI     | `gpt-5.6-luna`          | `gpt-5.6-terra`    | `gpt-5.6-sol`      | `gpt-5.6-luna`          |
| OpenRouter | `openrouter/auto`       | `openrouter/auto`  | `openrouter/auto`  | `openrouter/auto`       |

Compatibility aliases are still exposed for older call sites:

| Provider   | `primaryModel`     | `fallbackModel`      |
| ---------- | ------------------ | -------------------- |
| Gemini     | `modelPolicy.chat` | `modelPolicy.router` |
| Claude     | `modelPolicy.chat` | `modelPolicy.router` |
| OpenAI     | `modelPolicy.chat` | `modelPolicy.router` |
| OpenRouter | `modelPolicy.chat` | `null`               |

## Preview Defaults

Production defaults must not use model IDs containing `preview`, `latest`, or `experimental`.

Those model IDs are unstable for default routing because providers can change, deprecate, or rate-limit them on a shorter schedule. They are allowed only when a user explicitly supplies an OpenRouter override, because OpenRouter overrides are user-owned and not provider defaults.

`assertNoPreviewDefaults()` enforces this rule at module load time and the provider tests cover every configured tier.

## Pricing

Prices are standard USD per 1M tokens. Cached input is the provider's cache-read price when the provider publishes one. Cache-write pricing is included where the provider charges a distinct write price.

| Model                   |                   Input |            Cached input |             Cache write |                   Output |
| ----------------------- | ----------------------: | ----------------------: | ----------------------: | -----------------------: |
| `gemini-3.5-flash-lite` |                   $0.30 |                   $0.03 |                   $0.03 |                    $2.50 |
| `gemini-3.6-flash`      |                   $1.50 |                   $0.15 |                   $0.15 |                    $7.50 |
| `claude-haiku-4-5`      |                   $1.00 |                   $0.10 |                   $1.25 |                    $5.00 |
| `claude-sonnet-5`       |                   $3.00 |                   $0.30 |                   $3.75 |                   $15.00 |
| `claude-opus-5`         |                   $5.00 |                   $0.50 |                   $6.25 |                   $25.00 |
| `gpt-5.6-luna`          |                   $1.00 |                   $0.10 |                   $1.25 |                    $6.00 |
| `gpt-5.6-terra`         |                   $2.50 |                   $0.25 |                  $3.125 |                   $15.00 |
| `gpt-5.6-sol`           |                   $5.00 |                   $0.50 |                   $6.25 |                   $30.00 |
| `gemini-2.5-flash-lite` |                   $0.10 |                   $0.01 |                   $0.01 |                    $0.40 |
| `gemini-2.5-flash`      |                   $0.30 |                   $0.03 |                   $0.03 |                    $2.50 |
| `gemini-2.5-pro`        | Conservative cap: $2.50 | Conservative cap: $0.25 | Conservative cap: $0.25 | Conservative cap: $15.00 |
| `claude-sonnet-4-6`     |                   $3.00 |                   $0.30 |                   $3.75 |                   $15.00 |
| `claude-opus-4-7`       |                   $5.00 |                   $0.50 |                   $6.25 |                   $25.00 |
| `gpt-5.4-nano`          |                   $0.20 |                   $0.02 |                   $0.20 |                    $1.25 |
| `gpt-5.4-mini`          |                   $0.75 |                  $0.075 |                   $0.75 |                    $4.50 |
| `gpt-5.4`               |                   $2.50 |                   $0.25 |                   $2.50 |                   $15.00 |
| `openrouter/auto`       | Conservative cap: $5.00 | Conservative cap: $0.50 | Conservative cap: $5.00 | Conservative cap: $25.00 |

Legacy entries remain configured because explicit OpenRouter overrides can still report those model families and the cost guardrail needs an exact known price when they do.

Budget-cap estimation prefers the provider-reported model ID from each AI SDK step. Pricing lookup is provider-scoped: a direct provider accepts only its own model families and legitimate vendor prefix, while an explicit OpenRouter model must include a recognized vendor such as `openai/`, `anthropic/`, or `google/`. OpenRouter's `auto` and `openrouter/auto` IDs remain valid. Missing, unknown, disguised, or wrong-provider IDs fall back to conservative pricing instead of borrowing a cheaper rate from another provider.

OpenRouter charges the selected model's standard rate, and both its auto-router pool and explicit user overrides can include models outside Roni's pricing table. For an unknown OpenRouter response model, Roni uses the component-wise maximum input, cache-read, cache-write, and output rate across every pricing entry it knows. This is conservative within Roni's table, not a guarantee about every current or future OpenRouter model.

Personal API keys use these estimated cumulative-cost stop thresholds for each provider attempt:

| Provider   | 25-step reference estimate | Dominant input billing | Default threshold |
| ---------- | -------------------------: | ---------------------- | ----------------: |
| Gemini     |                  $24.20550 | Uncached               |            $25.00 |
| Claude     |                 $100.21625 | Cache write            |           $101.00 |
| OpenAI     |                 $100.72825 | Cache write            |           $101.00 |
| OpenRouter |                 $100.72825 | Cache write            |           $101.00 |

These thresholds are runaway guards, not hard caps, full-attempt guarantees, or expected spend. The context builder initially targets at most 500,000 estimated text tokens after reserving output and tool-definition headroom. The reference scenario adds 25% input-growth allowance (625,000 billed input tokens per step), then prices all 25 allowed steps at the 4,096-token output limit using conservative known rates. Behavior tests drive the real stop condition for uncached input, cache reads, and cache writes under that scenario.

The 625,000-token reference is not a runtime ceiling. The AI SDK appends assistant output and raw tool results during a multi-step loop, so later model input can exceed both the initial context target and the reference scenario. A sufficiently large loop can therefore reach a default threshold before the 25-step limit. Select **Ignore budget for all providers** when that behavior must be disabled rather than merely given a high threshold.

After each completed model step, Roni estimates the attempt's cumulative cost and stops before another step when the threshold has been reached or exceeded. Because the check runs after a step completes, that step can take estimated and actual spend above the configured threshold. The OpenRouter default covers Roni's known-rate estimate; an unknown model priced above those known rates can cost more.

Each retry or fallback is a fresh attempt with a fresh threshold, so one user turn can cross the threshold in more than one attempt. Users can store an independent threshold from $0.01 through $200.00 for each provider; the upper bound allows nearly twice the highest default while retaining typo protection. Settings edits the currently selected provider's threshold. **Ignore budget for all providers** is one global preference that removes the cost stop condition from every personal provider and is the explicit option for unbounded attempts. Provider thresholds remain stored while the global toggle is on and resume when it is turned off. Shared hosted AI does not use this personal-key guard.

Budget-stop telemetry records one `aiUsage` event per stopped attempt with `budgetScope: "model_attempt"`. The separate `aiRun` row remains a whole-turn aggregate, so its usage can include primary, retry, and fallback attempts.

## prepareStep

The chat loop passes a Vercel AI SDK `prepareStep` callback through `streamWithRetry`. The callback may switch only the model for a step; it does not filter tools. Tool subset routing remains out of scope for this policy.

Current prepareStep behavior:

- `router` stays on `router` for the whole turn.
- `programming` stays on `programming` for the whole turn.
- `chat` starts on `chat` and escalates to `programming` after a prior step uses a programming tool such as `program_week`, `create_workout`, `approve_week_plan`, or week-plan modification tools.

## Sources

- [Gemini models](https://ai.google.dev/gemini-api/docs/models)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Claude models](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [OpenRouter quickstart](https://openrouter.ai/docs/quickstart)
- [Vercel AI SDK loop control and prepareStep](https://ai-sdk.dev/docs/agents/loop-control)
