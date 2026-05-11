# AI Model Policy

Last reviewed: 2026-05-11

This policy defines the default production model tiers used by the coach. The source of truth in code is `convex/ai/providers.ts`; this document explains the intent, default model IDs, and standard pricing assumptions.

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

| Provider   | `router`                | `chat`              | `programming`     | `summarize`             |
| ---------- | ----------------------- | ------------------- | ----------------- | ----------------------- |
| Gemini     | `gemini-2.5-flash-lite` | `gemini-2.5-flash`  | `gemini-2.5-pro`  | `gemini-2.5-flash-lite` |
| Claude     | `claude-haiku-4-5`      | `claude-sonnet-4-6` | `claude-opus-4-7` | `claude-haiku-4-5`      |
| OpenAI     | `gpt-5.4-nano`          | `gpt-5.4-mini`      | `gpt-5.4`         | `gpt-5.4-nano`          |
| OpenRouter | `openrouter/auto`       | `openrouter/auto`   | `openrouter/auto` | `openrouter/auto`       |

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
| `gemini-2.5-flash-lite` |                   $0.10 |                   $0.01 |                   $0.01 |                    $0.40 |
| `gemini-2.5-flash`      |                   $0.30 |                   $0.03 |                   $0.03 |                    $2.50 |
| `gemini-2.5-pro`        | Conservative cap: $2.50 | Conservative cap: $0.25 | Conservative cap: $0.25 | Conservative cap: $15.00 |
| `claude-haiku-4-5`      |                   $1.00 |                   $0.10 |                   $1.25 |                    $5.00 |
| `claude-sonnet-4-6`     |                   $3.00 |                   $0.30 |                   $3.75 |                   $15.00 |
| `claude-opus-4-7`       |                   $5.00 |                   $0.50 |                   $6.25 |                   $25.00 |
| `gpt-5.4-nano`          |                   $0.20 |                   $0.02 |                   $0.20 |                    $1.25 |
| `gpt-5.4-mini`          |                   $0.75 |                  $0.075 |                   $0.75 |                    $4.50 |
| `gpt-5.4`               |                   $2.50 |                   $0.25 |                   $2.50 |                   $15.00 |
| `openrouter/auto`       | Conservative cap: $5.00 | Conservative cap: $0.50 | Conservative cap: $5.00 | Conservative cap: $25.00 |

Budget-cap estimation uses the reported model ID from each AI SDK step. If a step omits model metadata or reports an unknown model, the estimator falls back to the most expensive configured tier for that provider.

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
