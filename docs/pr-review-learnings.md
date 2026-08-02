# PR Review Learnings

Last reviewed: 2026-08-01

A running log of recurring, legitimate issues raised in pull-request review that
agents (and humans) should pre-empt. Each entry records the **problem**, **why
it matters**, and a **preventive check** to run before opening a PR. Entries are
distilled from real review threads — PR numbers are cited so the original
discussion can be traced.

These are conventions and checklists, not mechanically enforced rules. When one
conflicts with the AGENTS.md [Priority Hierarchy](../AGENTS.md#priority-hierarchy),
the hierarchy wins.

---

## 1. Don't let broad `catch` blocks swallow auth-expiry or non-transient errors

**Seen in:** #377, #354 (4+ review threads, the most repeated finding)

**Problem.** A fetch helper wraps a Tonal call in a broad `catch` that converts
_every_ failure into a benign empty result (`return []`, `return null`, or a
fake terminal page like `{ activities: [], pageSize: 0, pgTotal: 0 }`). This
silently absorbs:

- `TonalSessionExpiredError` / 401-refresh-failure errors thrown by
  `withTokenRetry`, and
- unexpected internal faults (e.g. `TOKEN_ENCRYPTION_KEY` misconfiguration,
  decrypt/cache-query errors).

**Why it matters.** Auth-expiry is a _signal_, not "no data." Swallowing it:

- makes `backfillUserHistoryWorkflow` treat an empty page as a successful
  terminal page, mark `syncStatus: "complete"`, and permanently under-backfill
  the account (#377);
- causes user-facing flows (strength trend, progressive overload, check-ins) to
  render a normal "Not enough data" state instead of routing the user to
  reconnect (#377, #354);
- turns operational outages into "detail missing," so they never surface in
  Sentry and are far harder to detect (#354).

**Preventive checks.**

- Only suppress **known transient** Tonal/network failures. Re-throw
  `TonalSessionExpiredError` and other auth/session errors so reconnect paths
  fire, and re-throw unexpected internal faults so they reach Sentry.
- Before adding `catch { return [] }` to a data-fetch helper, list its callers
  and confirm none rely on the error propagating (e.g.
  `fetchWorkoutHistoryOrEmpty` in `convex/progressiveOverload.ts` intentionally
  rethrows session-expired errors).
- State the error contract for each fetch helper explicitly: which errors return
  empty, which propagate.
- Note: the canonical reconnect surface for expired sessions is the
  profile-driven `StatusBanner` (`me.tonalTokenExpired`), so an `internalAction`
  may legitimately return empty to avoid Sentry noise — but a _user-facing_
  query/action must not mask the auth failure (#377).

## 2. Make tests exercise the real production path, with valid domain values

**Seen in:** #375, #354, #392, #371

**Problem.** Tests pass while the production path is broken because they don't
drive the real handler:

- #375 — the regression test stubbed a message with `status: "streaming"`, but
  the persisted `MessageDoc` status domain is `pending | success | failed`
  (`streaming` is a UI-only state). The test passed, yet the production fix never
  fired: `components.agent.messages.finalizeMessage` only mutates `pending`
  rows, so the new "streaming" finalize path was a no-op in prod.
- #354 — `simulateFetchWorkoutDetailCatch` _duplicated_ the catch logic in the
  test instead of calling the real `fetchWorkoutDetail` handler, so a regression
  in the real code could ship green.
- #392 — fixtures derived `expiresAt` from `Date.now()`, making tests
  time-dependent (violates the "tests must be deterministic" rule).

**Why it matters.** A test that doesn't touch the code under change gives false
confidence — the headline bug the PR claims to fix can remain unfixed.

**Preventive checks.**

- Drive assertions through the **real exported handler** (`fn._handler` with a
  mocked `ActionCtx`), mocking only at true boundaries (`global fetch`, DB,
  external APIs) — never duplicate or mock the internal function under test.
- Use only **valid domain values** in fixtures. Cross-check enum/status domains
  against the schema; a status the system can never persist won't exercise the
  real branch.
- Keep fixtures deterministic: fixed numeric constants instead of `Date.now()` /
  `Math.random()`.
- Prefer Zod `safeParse` over `as` casts when normalizing test input — an
  unchecked cast lets a wrong-shaped value (e.g. a string where an array is
  expected) pass `.length`-style assertions (#371).
- When a fix changes production behavior, confirm the test fails _without_ the
  fix before relying on it.

## 3. Match model IDs by family, not exact equality, on cost/budget paths

**Seen in:** #368 (multiple threads)

**Problem.** Pricing lookups used exact `===` on the model ID. Dated or
provider-suffixed variants (`claude-sonnet-4-6-20250514`, OpenRouter/OpenAI
aliases, `*-preview` overrides) no longer matched, so `getModelPricing` returned
`undefined`.

**Why it matters.** Missing pricing flows into `estimateAttemptCostUsd` →
`totalCostUsd` recorded as missing → treated as **zero** in circuit-breaker
aggregation. Spend thresholds and `budgetCapStopCondition` are silently bypassed,
weakening BYOK cost protection exactly on failed attempts. Related traps in the
same PR: routing complex/fallback turns through a model priced only at the _low_
prompt-size tier under-estimates large-context spend, and promoting fallback
attempts back to the `programming` tier re-triggers the failures fallback exists
to avoid.

**Preventive checks.**

- Match priced model IDs by **exact ID or hyphen-suffixed family prefix**, and
  add coverage for dated/aliased variants.
- Provide a **conservative fallback rate** for unknown IDs (especially
  user-supplied OpenRouter overrides) so failed attempts always contribute spend.
- For enforcement paths (budget cap, circuit breaker), price with the
  **worst-case / high prompt-size tier**, not the cheapest tier.
- Keep fallback routing pinned to the selected fallback tier; don't let a tool
  call escalate a fallback turn back onto the tier it was escaping.
- Keep `docs/ai/model-policy.md` aligned with the rates the runtime estimator
  actually enforces.

## 4. Derive watchdog/sweep timers from the action cap, not optimistic guesses

**Seen in:** #412

**Problem.** The stuck-message watchdog was scheduled _before_ provider
resolution, prompt/context building, and `streamWithRetry` (three 180s
attempts). The assistant row for the final attempt could be created more than
five minutes after the timer started; if that attempt was then killed by the
600s action cap, the single sweep saw the row as younger than
`STUCK_MESSAGE_GRACE_MS`, skipped it, and queued no later sweep — leaving the
spinner stuck indefinitely.

**Why it matters.** A self-healing mechanism that can fire before the thing it
heals exists (or before it has aged into the grace window) silently fails on
exactly the slow/retried turns it was built for.

**Preventive checks.**

- Derive sweep delays from the **Convex action cap**
  (`CONVEX_ACTION_MAX_MS = 10m`): set `GRACE = cap + margin` and
  `WATCHDOG_DELAY = grace + cap + margin`, so even a final-attempt row created at
  the very end of the action's life has aged past the grace window before the
  sweep fires.
- Add a regression test asserting the invariant (e.g.
  `WATCHDOG_DELAY - GRACE > CONVEX_ACTION_MAX_MS`) so it can't silently regress.
- Prefer a single larger fixed delay over self-rescheduling to keep the sweep
  stateless — but if you keep it single-shot, prove the timing window covers the
  worst-case retry path.

## 5. Error boundaries around optional integrations must recover and log

**Seen in:** #426 (2 review threads, both P2)

**Problem.** A new React error boundary wrapped the optional Garmin
"send-to-Garmin" card on the schedule detail page so a failure there couldn't
take down the whole route. But the boundary had two gaps:

- **No recovery.** It set `hasError` once on a `workoutPlanId:date` key and then
  returned `null` forever. A _transient_ `useQuery` failure (auth/session
  refresh, a momentary Convex query error) permanently hid the controls until
  the route remounted or the user navigated away — even though the query would
  have recovered on its own.
- **No logging.** It swallowed the render/query error without a
  `componentDidCatch` (or other) log path. Because it also stopped the app-level
  `ErrorBoundary` from seeing the error, a Garmin regression looked
  indistinguishable from "the optional integration is simply absent" — operators
  lost the only signal that the card was failing.

**Why it matters.** An error boundary added _for resilience_ can quietly make
things worse: it converts a recoverable, observable failure into a permanent,
invisible one. The integration appears gone rather than broken, so neither the
user nor Sentry/operators ever learn it regressed.

**Preventive checks.**

- Give every error boundary a **recovery path**: a retry control that resets the
  boundary state (or render from local safe query state) so a transient failure
  clears when the underlying query recovers. Don't latch `hasError` for the life
  of the key.
- Always **log the caught error** in `componentDidCatch` (or equivalent) with a
  named message, even when you intentionally keep the rest of the page visible —
  a boundary that hides a card must not also hide the signal.
- When a boundary deliberately stops the app-level `ErrorBoundary` from seeing an
  error, it owns the observability for that subtree. Confirm the error still
  reaches the logs.
- Add regression coverage for the **recovery** transition (toggle the mocked
  query failure → success and assert the card returns), not just the
  failure-hides-card case.

## 6. Validate new credential/ID formats against a real example, and update every copy of the check

**Seen in:** #417 (P1)

**Problem.** The PR existed to unblock Google "Express Mode" Gemini keys, which
are issued with an `AQ.` prefix (e.g. `AQ.Ab8...`). The validation regex allowed
only `[A-Za-z0-9_-]` immediately after `AQ`, so it rejected the literal dot —
meaning the change failed to accept the exact key format it was written to
support. The same regex was **duplicated in three places** (`convex/ai/providers.ts`,
the `prepareGeminiKeyForStorage` storage helper, and the client-side
`ApiKeyForm`); the dot had to be added to all three or the key would still fail
at one layer.

**Why it matters.** A validator written from an assumed format rather than a real
sample silently defeats its own purpose — the feature ships "done" but the
target input still bounces. And when the same rule is copied across client +
storage + provider layers, fixing one copy leaves the others to reject the input
at a different boundary, which is hard to diagnose.

**Preventive checks.**

- Before changing a format validator (API-key prefix, ID pattern, sentinel),
  paste a **real, full example** of the target value and confirm the
  pattern/branch actually accepts it end-to-end — don't infer the charset.
- Grep for **every copy** of the validation rule (client form, storage helper,
  provider/server check) and update them together; add a matching test in each
  file so a future divergence is caught. Consider whether the duplicated regex
  should be a single shared constant.
- Add a positive test using the literal target format (here, an `AQ.`-prefixed
  key) at each validation layer.

## 7. When a transform filters elements out of a payload, keep counts and structural markers consistent — and guard the empty result

**Seen in:** #440 (3 review threads: 1 P2, 2 P3, plus a CodeRabbit P2)

**Problem.** `buildTonalWorkoutSets` started dropping synthetic movements (e.g.
injected `Rest` sentinels) from the Tonal payload, but the rest of the push path
wasn't updated to match the filtered list:

- **Empty result wasn't guarded.** A block containing only synthetic movements
  filtered down to `[]`, yet `pushWorkoutToTonal` still POSTed the empty `sets`
  to `/v6/user-workouts`. Tonal returned a misleading 400 and `createWorkout`
  recorded a failed plan — instead of failing fast locally with a clear error
  (the estimate path already rejected empty payloads; the push path didn't).
- **Count came from the unfiltered source.** `createWorkout` reported `setCount`
  from a separate unfiltered `expandBlocksToSets(blocks)` calculation, so a
  3-work-set + 3-rest-sentinel block reported 6 sets pushed while only 3 reached
  Tonal — the user/LLM-visible success message overstated the result.
- **A structural marker was lost with the element it sat on.** When a block began
  with a synthetic movement, filtering removed the only set marked
  `blockStart: true`, so the first _real_ set went out as `blockStart: false` and
  the Tonal payload's block boundaries no longer matched the validated block
  structure.

**Why it matters.** A filter step that drops elements quietly desynchronizes
everything derived from the original list — counts, boundary markers, and the
"is there anything left?" precondition. The failures surface as opaque remote
errors or wrong user-facing numbers, far from the filter that caused them.

**Preventive checks.**

- After filtering, **guard the empty result** and fail fast locally with a
  descriptive error _before_ constructing/sending the remote payload — don't let
  an external API translate "nothing to send" into a confusing 4xx.
- Derive **counts and summaries from the post-filter list**, never from a
  parallel unfiltered calculation of the same data.
- **Re-establish structural anchors** (block starts, "first"/"last" flags,
  ordinal indices) on the filtered list when the element that carried them can be
  removed — or reject inputs that would place a marker on a droppable element.
- Add coverage for the **all-dropped** case and the **leading-element-dropped**
  case, not just the happy middle.

## 8. Preserve the concrete error class through fallback layers, and emit time-sensitive alerts before long awaits

**Seen in:** #434 (2 review threads, both P2)

**Problem.** Adding fallback context to the circuit-breaker alert introduced two
gaps:

- **The terminal error class was flattened.** When a fallback attempt ended with
  `{ done: true, success: false }` for a _known_ non-transient class (BYOK,
  quota, etc.), the alert reported a generic `TerminalFallbackAttemptFailure`
  instead of the real class `resilience.ts` had already identified — losing the
  diagnosis exactly when fallback fails for a knowable reason.
- **A notification was awaited behind a long operation.** The breaker-open alert
  was delayed until after the final fallback attempt finished. With each attempt
  budgeting 180s under Convex's 600s action cap, two primary timeouts plus the
  fallback could run close enough to the cap that the action is killed before the
  notification is ever sent — even though the breaker had already opened.

**Why it matters.** Observability degrades precisely on the worst failures: the
alert that should explain a terminal failure either misreports the cause or never
fires because the action died first.

**Preventive checks.**

- Carry the **concrete error class** through your `AttemptOutcome`/result type and
  use it for _both_ primary and fallback terminal notifications — don't substitute
  a generic sentinel when the real class is already known.
- Emit **minimal state-change alerts (breaker-open, etc.) before** awaiting a long
  final operation; record the operation's outcome in a _separate_ follow-up or a
  best-effort `finally`, so an action killed at the cap still surfaces the state
  change. (See also §4 — budget all timing against `CONVEX_ACTION_MAX_MS`.)
- Add a regression test asserting the alert is sent **before** the final fallback
  await, and that a known terminal class propagates into the alert payload.

## 9. Type external fields as nullable to match the real payload, and don't let connect-time normalization clobber stored values on refresh

**Seen in:** #429 (1 P2 review thread + 1 CodeRabbit Major)

**Problem.** Normalizing Tonal sub-account profile data surfaced two issues:

- **The type lied about the payload.** `TonalUser` declared `heightInches`,
  `weightPounds`, and `workoutsPerWeek` as non-nullable `number`, but the mapper
  already did `?? 0` and a test fed `null` for these fields — Tonal really does
  return `null`. The interface said the null case couldn't happen while the code
  handled it, hiding the null-handling contract from every consumer.
- **Connect-time normalization ran destructively on refresh.** The `?? 0`
  fallback is necessary for first-time-connect validation, but it also ran on
  refresh/backfill — and `updateProfileData` replaces the whole stored
  `profileData`. So a user with real height/weight/frequency could be **downgraded
  to `0`** when a later Tonal payload merely said those values were unknown, and
  the zeros then leaked into AI context (`0"/0lbs`, `0x/week`).

**Why it matters.** A type that doesn't model the real nullable shape lets
null-handling bugs through silently. And a normalization default that's safe at
first-connect becomes _data corruption_ on refresh — "value unknown right now"
must never overwrite a previously known value.

**Preventive checks.**

- Type external/API fields as `number | null` (etc.) to **match what the payload
  actually sends**; cross-check the mapper's `?? ` fallbacks and any test that
  passes `null`. If you're defaulting a value, the source type is probably
  nullable.
- Distinguish **first-time-connect normalization from refresh/backfill**. On
  refresh, fall back to the **existing stored value** before any hardcoded default,
  and never replace a known value with a default derived from a "value unknown"
  payload.
- Add a regression test asserting refresh **preserves stored measurements** when
  the latest payload returns `null` for those fields.

## 10. When resolving an AI-supplied name/ID to a catalog entry, prefer the exact match, return candidates for fuzzy ones, and never silently substitute

**Seen in:** #465 (4 P2 review threads)

**Problem.** `resolveMovement` was made the gatekeeper that turns the coach's
`create_workout` movement references (`name` + optional `movementId`) into real
Tonal catalog rows. Four ways it resolved to the _wrong_ entry — silently
pushing the wrong exercise onto the user's Tonal workout, the exact failure the
change was meant to prevent:

- **A supplied ID won over the name.** When both `name` and `movementId` were
  present, a valid-but-stale/copied ID resolved immediately and the requested
  name was never checked — so an LLM reusing a real ID from a different exercise
  pushed the wrong movement even with the correct name.
- **A broad fuzzy match was auto-substituted.** Non-catalog names reused
  `matchesNameSearchStrict` (matches if any 3+ char word appears), then silently
  pushed the sole match — e.g. `Decline Push-up` resolved to
  `Standing Decline Chest Press`.
- **Exact full name lost to another row's `shortName` alias.** When a name
  exactly matched one movement's full `name` _and_ another's `shortName`, both
  were combined and returned `ambiguous`, blocking a valid call instead of
  resolving the unambiguous full-name match.
- **A required `name` field rejected catalog-exempt sentinels** (see §11).

**Why it matters.** A resolution layer that auto-resolves on weak evidence
converts a "help the model" feature into silent data corruption — the wrong
exercise reaches Tonal with no error. And one that's _too_ strict (returns
`ambiguous` on an unambiguous match) blocks valid tool calls.

**Preventive checks.**

- **Order match precedence explicitly, and verify the exact full name before
  trusting a supplied ID:** exact full `name` → valid/well-known ID → exact
  `shortName` alias (the order `resolveMovement` actually implements). Check the
  exact _full-name_ match _before_ accepting a supplied `movementId` so a
  stale/copied ID can't win over the correct name — but keep the ID ahead of the
  `shortName` alias, because a generic alias that collides with another row would
  otherwise redirect a valid-ID request to the wrong exercise. Reject ID/name
  mismatches rather than letting the ID win — resolution sits between a fallible
  LLM and an external write, so "resolve to something plausible" is the wrong
  default.
- **Only auto-resolve on exact matches.** Return any fuzzy/partial-word match as
  an `ambiguous` candidate for the model to confirm — never silently substitute a
  lone fuzzy hit.
- Add coverage for each trap: stale-ID-vs-correct-name, broad-single-word-fuzzy,
  and full-name-vs-other-row's-shortName.

## 11. Keep AI tool-input (Zod) schemas permissive when downstream logic normalizes or resolves the value

**Seen in:** #460 (1 P2), #465 (1 P2)

**Problem.** Tool-input validation ran _before_ `execute`, so a strict Zod schema
rejected malformed-but-repairable AI output before the repair code could run:

- #460 — `create_workout` reps/duration were tightened to `.positive()` to fix
  `reps: 0`/negative AI output (#447). But that rejected the bad input at the
  schema boundary, so the standalone `create_workout` path never reached the new
  `positiveOr` clamp in `buildTonalWorkoutSets` and still failed on the exact
  #447 input — even though the retry/week-plan paths normalized fine.
- #465 — making `name` _required_ in the `create_workout` schema meant the
  documented `Rest` sentinel (catalog-exempt, supplied by `movementId` only, can't
  come from `search_exercises`) was rejected by Zod before `resolveMovement`'s
  `isWellKnownMovementId` path could handle it, unless the model invented a `name`.

**Why it matters.** When a downstream step exists specifically to repair or
resolve imperfect model output (clamp, normalize, resolve-by-id), a strict schema
upstream silently defeats it on exactly the inputs it was built for — and the bug
only shows on the one path that lacks a parallel pre-normalization step.

**Preventive checks.**

- If you add a clamp/normalize/resolve step, make the **tool-input schema
  permissive** for that field (`int().optional()`, optional `name`, etc.) and let
  the downstream step own correctness — validate-then-repair, not reject-at-schema.
- When tightening a tool schema, list **every execution path** that field flows
  through; confirm none rely on the old permissive shape to reach a repair step.
- Add coverage that drives the **real tool/execute path** with the malformed input
  (e.g. `reps: 0`, Rest-by-id-only), not just the already-normalized callers.

## 12. Model-tier routing is two decisions (primary tier + fallback tier): reroute the one buggy branch instead of gutting the gate, and re-check tier→model mappings per provider

**Seen in:** #469 (4 review threads)

**Problem.** Short workout requests were landing on the flash-lite `router`
tier, which doesn't reliably drive `search_exercises → create_workout`. The
first cut deleted the whole routing classifier so chat turns always started on
the `chat` tier — which dropped behaviors the gate also provided and rippled into
the retry/fallback path:

- **Lost complex→programming routing.** The classifier also routed `complex`
  prompts ("program a week" / "build a plan") to the `programming` tier. Removing
  it meant BYOK Claude/OpenAI planning requests started on the cheaper `chat` tier
  (Sonnet / GPT-mini) and only escalated _retrospectively_ in `prepareStep` after
  a programming tool had run — weakening the path the programming tier (Opus /
  GPT-5.4) is reserved for.
- **The fallback tier is a separate decision.** `selectCoachTierRoute` derives the
  fallback via `getFallbackTier(primaryTier)`, and `getFallbackTier("chat")` is the
  `router`/flash-lite tier. The fallback agent runs the _same turn_ on
  circuit-open/timeout, so changing the primary tier silently changes which model
  handles the failure path too.
- **Per-provider model policy constrains the fallback.** On the default Gemini
  house key, `chat` and `programming` both resolve to `gemini-2.5-flash`, so
  bumping the chat fallback to `programming` would re-run the _same_ model on
  fallback — dropping the distinct `flash-lite` fallback that protects against a
  flash outage / circuit trip. On Gemini a fallback cannot be both distinct from
  flash _and_ reliable at tool-calling.

**The accepted resolution was surgical and deliberately kept the router
fallback.** PR #469 reverted the fallback-tier change and rerouted only the
`trivial` branch to the `chat` tier, leaving `complex → programming` and
`getFallbackTier("chat") = "router"` intact. The short-request fix relies on the
**primary** now being the tool-capable `chat` tier; only the rare
circuit-open/timeout path falls through to flash-lite, and the maintainer
**accepted that residual** to preserve Gemini's distinct-model fallback. Current
main codifies this: `convex/ai/providers.test.ts` asserts
`getFallbackTier("chat") === "router"`, and `convex/chatProcessing.test.ts`
asserts the trivial route's `fallbackTier` stays `router`.

**Why it matters.** A multi-branch classifier encodes several decisions at once;
deleting it to fix one branch takes the others with it. And the fallback tier is a
_second_ decision that interacts with per-provider model policy — so the "obvious"
fix (force the fallback onto a tool-capable tier) can regress a different provider.
The lesson is to weigh both tiers and **record the tradeoff**, not to mandate a
non-router fallback.

**Preventive checks.**

- **Prefer the surgical reroute.** When one branch of a classifier/router is wrong,
  change that branch (here: `trivial → chat`) and leave the others
  (`complex → programming`) and the fallback tier untouched — don't delete the
  whole gate.
- **Trace both the primary and the fallback tier**, and remember the fallback agent
  runs the _same turn_ on circuit-open/timeout. Resolve each against the **active
  provider's model policy** before concluding a fallback is "safe" — it can
  collapse to the same model under one provider even when it looks distinct in the
  abstract.
- **Record the tradeoff instead of mandating one side.** When a provider can't
  offer a fallback that is both distinct-from-primary and tool-capable, that's a
  conscious choice, not a bug: #469 kept the distinct flash-lite/`router` fallback
  because the primary path is already tool-capable. Do **not** add an invariant
  that the fallback is never `router` — current tests intentionally assert the
  opposite.
- Assert the invariants the decision actually protects (e.g. `complex` still maps
  to `programming`; the `trivial` route's primary is `chat`), so the surgical fix
  can't silently regress.

## 13. An internal action reachable without its tool schema must validate its own input

**Seen in:** #493 (1 CodeRabbit Major)

**Problem.** `rebuildDay` was exposed as an `internalAction` that other backend
paths (the week-plan rebuild flow, the scheduler, tests) call **directly**,
without passing through the `rebuild_day` tool's Zod schema. Its internal
validator accepted empty `blocks`/`exercises` arrays and unconstrained numeric
`sets`/`reps`/`duration` (non-integer, non-positive). So a malformed payload from
a direct caller could create a draft plan and leak invalid exercise data into
persistence — the tool schema's range/integer constraints never ran. The fix
added `validateRebuildDayBlocks`, which runs at the action boundary (before
catalog resolution and draft creation) and returns a structured
`{ ok: false, error }` instead of throwing.

**Why it matters.** §11 deliberately keeps a _tool-input_ schema permissive
because a downstream normalize/clamp/resolve step owns correctness — but that
reasoning only holds for callers that actually cross the tool boundary. An
`internalAction` (or anything reachable from the scheduler, another action, or a
test) bypasses the tool's Zod schema entirely, so "the schema already validated
this" is false for the direct path. Validation has to live at whichever boundary
**every** caller crosses, or the unguarded path silently persists garbage.

**Preventive checks.**

- For any `internalAction`/handler reachable **without** the tool Zod schema
  (week-plan paths, crons, action→action calls), validate array bounds and
  numeric domains (integer / positive / range) at the action boundary _before_
  persisting or calling an external API — don't assume the tool schema ran.
- Mirror the tool schema's real constraints in the internal validator (or factor
  one shared validator) so a direct call can't accept what the tool path rejects.
- Reconcile with §11: keep the field permissive **only where a downstream repair
  step exists on that same path**. If the direct/internal path has no clamp (as
  here), validate the domain at the boundary; if it does share the clamp, stay
  permissive and let the clamp run. The deciding question is "does this exact
  caller reach the repair step?", not "is there a repair step somewhere."
- Return a structured `{ ok: false, error }` for invalid internal input rather
  than throwing, matching the action-return-object convention.
- Add coverage that drives the internal action **directly** with malformed input
  (empty blocks, `sets: 0`, non-integer reps), not just the tool-path callers.

## 14. Adding `"types": ["node"]` to the shared Convex tsconfig masks Node-only globals leaking into default-runtime files

**Seen in:** #557 (1 P2 review thread). **Fixed in:** #581.

**Problem.** #557 restored the `npx convex deploy` typecheck by adding
`"types": ["node"]` to `convex/tsconfig.json`. But that tsconfig typechecks
**every** Convex module, not just the `"use node"` action files — and some Node
globals are only real at runtime in `"use node"` modules. Convex's default
(V8, browser-like) runtime does **not** provide `Buffer` (note: it _does_
expose `process.env`, which no-directive actions like `convex/tonal/proxy.ts`
read intentionally — so this is about the genuinely unavailable globals such as
`Buffer`, not `process.env`). Declaring Node types globally tells the
typechecker those globals exist everywhere, so it stops flagging their use in
default-runtime files.

The concrete leak before #581: `estimateCacheValueBytes` in
`convex/tonal/proxyCacheLimits.ts` called `Buffer.byteLength(...)`, and it was
reachable via `isCacheValueWithinLimit` from the registered default-runtime
action in `convex/tonal/proxy.ts`, on the cache-write path. The missing
`Buffer` threw, and the surrounding `try/catch` treated the failure as
`Number.POSITIVE_INFINITY`, so `isCacheValueWithinLimit` returned `false` and
`cachedFetch` **skipped the cache write** — disabling stale-while-revalidate
and driving extra external Tonal calls on every fresh fetch. The global Node
types meant deploy typecheck could not catch this.

**Why it matters.** A tsconfig change made to _restore_ a safety check can
quietly _widen_ the runtime/typecheck gap: the typechecker now vouches for
Node APIs in files that will never have them, so a latent
`ReferenceError`-swallowed-into-a-benign-default bug (see also §1 on broad
catches hiding non-transient failures) ships green. The failure isn't fully
silent — `proxy.ts:113` logs `payload too large to cache, skipping write` — but
that message _misattributes_ the cause: caching stops for that endpoint because
of a missing global, not an oversized payload, so the log points diagnosis in
the wrong direction.

**Preventive checks.**

- Prefer **Web-standard APIs over Node globals** in any module that can run in
  the default runtime. Replace `Buffer.byteLength(s, "utf8")` with
  `new TextEncoder().encode(s).byteLength`, which is valid in both Convex
  runtimes.
- Understand what `"types": ["node"]` in the shared config can and can't buy
  you. `"use node"` selects the Convex Node runtime for a _file_, but it does
  **not** scope TypeScript's `compilerOptions.types` — `types` is a project-wide
  setting, so there is no per-file escape hatch. And `npx convex deploy`
  typechecks against the shared `convex/tsconfig.json`: splitting Node/test
  files into a separate tsconfig only helps if you actually wire that second
  project into the deploy/CI check (a two-project `tsc -b`, or a runtime-aware
  lint rule) — otherwise you either exclude those files from the deploy
  typecheck entirely or leave their ambient Node declarations visible
  project-wide. Because Convex's own guidance is to keep `"types": ["node"]` in
  the shared `convex/tsconfig.json`, treat the primary defense above (don't use
  the unavailable globals in shared code) as the reliable remedy, not the
  tsconfig split.
- When a helper touches a Node-only global, trace it to the registered action
  entrypoints that can reach it, not just its immediate importers: a helper is
  only safe to use `Buffer` if **every** default-runtime (no-`"use node"`)
  entrypoint that can execute it is excluded. An intermediate importer lacking
  the directive can still run exclusively inside a Node action bundle, so the
  quick "any importer without `"use node"`" grep can flag valid Node-only
  chains — confirm at least one default-runtime entrypoint actually reaches it.
- Watch broad `try/catch` around size/serialization estimates — a swallowed
  `ReferenceError` that returns a "too big / can't cache" sentinel disables
  caching under a misleading payload-size log instead of surfacing the missing
  global.

## 15. Per-turn telemetry must record what actually happened — never let default/initial values, pre-trim intent, or context-expansion artifacts count as measurements

**Seen in:** #595 (2 P2 threads), #598 (2 P2 threads), and the broader intent of
#591 ("repair AI telemetry integrity")

**Problem.** New AI metrics were biased because the recorded value diverged from
the thing being measured:

- **Defaults recorded as measurements on failure paths.** #595 initialized the
  per-turn timing object with `searchHits: 0` / `searchUsed: false`. When
  `continueThread`/context retrieval failed _before_ the context handler ran,
  `streamWithRetry` still returned and persisted the accumulator, so a retrieval
  failure was recorded as an instrumented "zero-hit, search-unused" turn —
  dragging the new hit/usage rates toward zero exactly on the broken turns.
- **Counting a post-expansion artifact instead of the semantic quantity.** #595
  counted `args.search` length as `searchHits`, but the production
  `messageRange: { before: 2, after: 1 }` means one real match expands to up to
  four context messages — so `totalHits` tracked the configured context window,
  not retrieval effectiveness.
- **Counting pre-trim intent instead of what the model received.** #598 set
  `memoryFactsInjected` from the facts _gathered_, but `trimSnapshot` can drop the
  whole priority-one section when it exceeds `SNAPSHOT_MAX_CHARS`, so a turn where
  the model saw zero facts still landed in the `withFacts` cohort and biased the
  pilot comparison.
- **Failed turns counted in a success cohort.** #598 selected memory-cohort rows
  by a non-error `finishReason` (e.g. `tool-calls`), but `RunAccumulator` can
  carry a set `terminalErrorClass` alongside that finish reason, so a terminally
  failed turn's partial search sequence was attributed to a cohort.

**Why it matters.** A metric added to make a tune-or-disable / A-B decision is
worse than no metric if it systematically mis-measures the failure, empty, or
trimmed cases — the bias points the decision the wrong way and looks precise
doing it.

**Preventive checks.**

- **Initialize telemetry fields as absent/undefined, not as a measured zero.**
  Let the code path that actually performs the measurement set the explicit value
  (including an explicit zero), and set it on _every_ completion path that reaches
  persistence — including `continueAfterApproval` and other secondary entrypoints.
- **Count the semantic event, before any downstream expansion or trimming.**
  Record matched-result count before `messageRange` expansion; derive
  "injected"/"rendered" counts from the final post-`trimSnapshot` snapshot, not
  the pre-trim gather (see also §7 — counts must come from the post-filter list).
- **Exclude failed/partial samples explicitly.** Include `terminalErrorClass` in
  the row shape and reject any row where it is set, even when `finishReason` looks
  successful — `streamWithRetry` reports terminal failures in the returned
  accumulator, not by throwing (see §8, §18).
- Add coverage for the failure/empty/trimmed sample, asserting it is _excluded_
  from the rate/cohort — not just that the happy path is counted.

## 16. A hand-written keyword/regex intent classifier that gates tool availability is brittle — and the gate must persist across the whole multi-turn lifecycle

**Seen in:** #590 (12 review threads — the single largest cluster in this batch)

**Problem.** #590 restricted weekly-programming turns to the draft-and-approval
tools by classifying intent from the user's prompt text with an anchored
verb/word-order whitelist. Both halves of the design leaked:

- **The phrasing whitelist was trivially bypassed.** Ordinary rephrasings fell
  through to the default `all` mode and re-exposed `create_workout`/`delete_workout`
  on exactly the weekly flows the guard protects: modal prefixes ("Can you give
  me a 3-day plan?", "Could you…"), alternate word order ("For next week, create
  me a plan", "I need a PPL split"), and weekly _deletion_ verbs ("Delete my
  weekly plan", "Discard this week's plan") that the action-verb list omitted. A
  bare "this workout" one-off override also matched _before_ the weekly patterns,
  disabling the restriction even when a weekly pattern also matched.
- **The gate reset mid-lifecycle.** The weekly lifecycle is multi-turn
  (draft → "looks good, push it" → approval continuation). `continueAfterApproval`
  hardcoded `toolMode: "all"`, so the restriction applied on the initiating turn
  vanished the moment an approval-gated tool ran, and any subsequent step/retry
  regained the standalone tools.
- **Inferred state was scoped too broadly.** The "there is a pending weekly draft"
  signal was a _user-wide_ boolean, so terse follow-ups ("delete it", "push it")
  were classified as weekly in _every_ thread — removing one-off tools from an
  unrelated conversation about a standalone workout.

**Why it matters.** When a keyword classifier is the _sole_ gate for a
safety-relevant decision (which write tools the model may reach), every phrasing
it fails to anticipate is a silent bypass, and every lifecycle transition it
doesn't carry through re-opens the hole. Brittleness here isn't a cosmetic
false-negative — it defeats the restriction's purpose.

**Preventive checks.**

- **Don't rest a safety restriction on an anchored phrasing whitelist alone.** If
  a keyword classifier must exist, enumerate synonyms/verbs/modal-prefix forms and
  test them, but prefer deriving intent from **durable state** (an actual pending
  weekly-draft row for _this thread_) over parsing free text. Evaluate the
  higher-precedence (weekly) patterns before a permissive one-off override.
- **Carry the restriction through the entire lifecycle.** Persist the originating
  tool mode and reuse it in approval continuations and retries; default only
  genuinely legacy/unclassified continuations to `all`. A gate applied on turn N
  must still hold on the continuation turn N+1.
- **Scope inferred conversation state to the active thread**, not a user-wide
  "any draft exists" flag, so state in one conversation can't restrict tools in
  another.
- **Route intent and tool mode from the same state-aware signal.** #590 also
  computed the routing tier from the raw prompt while the tool mode used draft
  state, so a terse weekly follow-up ran `chat`→`router` instead of
  `programming` — cheaper/less tool-reliable models on the exact turn that needs
  programming (ties to §12: primary _and_ fallback tier both follow from the
  route).
- Add coverage for the bypass phrasings, the post-approval continuation retaining
  the restriction, and a cross-thread case (weekly draft present, standalone
  request in a different thread stays unrestricted).

## 17. A cached/projected fast-path in front of a live source must verify freshness from the newest record and mark freshness on every populate path

**Seen in:** #592 (7 review threads)

**Problem.** #592 added an indexed `exercisePerformance`/`completedWorkouts`
projection as a fast path in front of the multi-second live Tonal history+detail
fetch, returning `ready | miss | limit_exceeded`. Several ways the "fast" path
returned stale data or never engaged:

- **`ready` didn't imply fresh.** A workout completed after the last history sync
  still satisfied every structural `ready` check, so the early return served a
  projection missing the newest workout's PRs/regressions until the scheduled sync
  ran. A freshness bound / latest-activity check was needed before trusting it.
- **The freshness watermark was taken from the wrong end.** `fetchRecentWorkoutActivities`
  returns activities newest-first, but the watermark was derived from
  `activities[activities.length - 1]` (the _oldest_ in the batch) and stored as
  `lastSyncedActivityDate`, so after every normal incremental sync the profile's
  date lagged `workouts[0].date` and the projection returned `miss`.
- **Not every populate path marked freshness.** Only the incremental-sync path
  advanced `workoutProjectionSourceFetchedAt`; the backfill workflow populated the
  same tables but never set it, so newly onboarded users had a permanent `miss`
  (cacheAge computed from zero) and kept paying the live-fetch cost.
- **The fallback never completed verification.** When the projection was stale the
  fallback refreshed the `workoutHistory_v4` cache but didn't persist/verify a
  snapshot; `startSyncUserHistory` then saw the fresh cache timestamp and skipped
  the workflow, so frequent requests kept the projection permanently unverified.
- **Verification read a shared denormalized timestamp instead of its own fetch.**
  Re-reading `workoutHistoryCachedAt` after the fetch could pick up _another_
  caller's newer snapshot and mark it "verified" against this action's older list.
- **Same-day ordering used a truncated/string key.** `completedWorkouts.date` is
  `YYYY-MM-DD`, and PR detection assumes `sessions[0]` is latest; the index
  tie-break (and a raw-string `activityTime` compare that ignored UTC offsets)
  could put an older same-day workout first, producing false PR/regression calls.

**Why it matters.** A projection added _for latency_ silently trades correctness
for speed if `ready` doesn't mean current: it serves stale analytics, or — when
the watermark/verification logic is off — never engages at all and keeps the slow
path it was built to remove, so the PR ships without delivering its measured win.

**Preventive checks.**

- **Separate "structurally complete" from "fresh."** Before returning a cached
  projection, verify it covers the latest known activity (or enforce an explicit
  freshness bound); don't let passing shape checks imply currency.
- **Derive the freshness watermark from the newest record**, minding the source's
  sort order (newest-first vs oldest-first), and carry the timestamp of the exact
  fetch through the sync rather than re-reading a shared denormalized field that a
  concurrent caller may have advanced.
- **Mark the projection verified on _every_ path that populates it** — backfill
  and incremental sync alike — and make the fallback path complete verification,
  so the fast path can actually become `ready` after onboarding and after a
  fallback refresh.
- **Order same-day records by a full timestamp compared as an instant**, not a
  truncated date or a raw ISO string (timezone offsets sort wrong); reject rows
  whose timestamp can't be parsed when ordering matters for correctness.
- Add coverage for: a workout completed after last sync (freshness miss), a
  multi-date incremental batch (watermark = newest), post-backfill readiness, and
  the fallback-refresh path reaching `ready`.

## 18. A new async/secondary step bolted onto an existing pipeline must inherit every guard the primary path already enforces

**Seen in:** #598 → #600 (the seven "late review findings" that #600 existed to fix)

**Problem.** #598 attached a new background preference-extraction step (and a
memory-fact context source) to the coach turn. It worked in isolation but skipped
guards the primary chat path already had, so #600 had to retrofit each one:

- **Quota double-charged.** The background extractor re-called
  `resolveUserProviderConfig`, whose `_checkHouseKeyQuota` consumes a per-message
  unit — so one user message spent two of the advertised 500 monthly units, and
  extraction silently failed when the second charge crossed the cap. #600 split
  quota-charging chat config from quota-free background credential resolution.
- **Account-deletion short-circuit not inherited.** When deletion began mid-turn,
  `readUserProfile` deliberately returned `null`, but the new profile-missing
  branch still attached every fetched memory fact — leaking preferences to the
  external model _after_ the deletion guard fired. #600 short-circuits all snapshot
  sources while deletion is in progress.
- **Post-turn work gated on `catch`, not the terminal outcome.** Extraction was
  scheduled from the surrounding `try` block, but `streamWithRetry` absorbs
  terminal BYOK/quota/non-transient failures into the returned accumulator instead
  of throwing — so a turn the user only saw fail still scheduled another provider
  call and could persist a preference. #600 gates scheduling on the accumulator
  having no `terminalErrorClass` (see §8, §15).
- **Concurrent writes/removals raced.** Independently scheduled extraction actions
  could complete out of order and let an older turn overwrite a newer contradictory
  preference (last-write-wins with no ordering); the removal UI shared a single
  `pendingFactId`, so removing fact A then fact B crossed their enabled/confirm
  state. #600 orders persistence by source-message creation time (breaking ties by
  a deterministic ID) and disables all removal controls while any deletion is
  pending.

**Why it matters.** Each guard on the primary path (quota accounting, deletion
short-circuit, terminal-error gating, write ordering, per-item UI state) encodes a
correctness or safety invariant. A secondary step that reuses the primary's
building blocks inherits their _mechanics_ but not their _guards_ unless you
re-check each one — and the gaps surface as quota exhaustion, data leaks after
deletion, work done for failed turns, and stale/crossed state.

**Preventive checks.**

- Before shipping a new background/secondary step on an existing turn or sync,
  **walk the primary path's guards explicitly** and confirm the new step honors
  each: metered-resource accounting (don't reuse a quota-consuming resolver for a
  non-user-visible call), account-deletion/data guards, terminal-outcome gating
  (`terminalErrorClass`, not `catch`), and idempotency/ordering under concurrency.
- **Never break last-write-wins ties by an opaque ID's lexicographic order** —
  carry a semantic sequence (source-message `_creationTime`/conversation `order`)
  and reject writes older than the stored source, so out-of-order async completion
  can't resurrect stale data. (An equal-`_creationTime` ID tie-break was still
  flagged on #600 — ensure the tie-breaker is a real ordering, not `messageId`
  string comparison.)
- Give each concurrently-actionable UI row **independent pending state**, or
  disable the whole group while any action is in flight — don't share one pending
  key across rows.
- Add coverage that drives the secondary step under each failure/edge condition
  (house-key quota near the cap, deletion-in-progress, a terminal coach failure,
  two out-of-order writes), asserting the guard holds.

## 19. Receipt-only retry guards are not idempotency when an external POST can finish ambiguously

**Seen in:** #616, #619 (follow-up)

**Problem.** A stored signup receipt prevented ordinary duplicate scheduling,
but it could be stale after a user removed or moved a Tonal Calendar tile, and
two approvals could both pass the preflight before either wrote the receipt.
A token refresh after an ambiguous POST could also repeat the POST because Tonal
does not accept an idempotency key.

**Preventive checks.**

- Treat a recent receipt as a short-lived read optimization, not proof forever.
- Acquire a durable lease before live reads, authorize POST atomically only after
  a successful absence, and retain post-authorization ambiguity for the next
  caller to reconcile. Never POST after a failed calendar read.
- A downstream lease keyed by workout-plan ID cannot serialize concurrent
  upstream creates that produce different IDs. Make the draft-to-pushed day link
  an ownership-checked compare-and-swap; the loser must re-read and schedule the
  canonical linked pushed plan, or defer retryably without a calendar call when
  no valid canonical plan exists. Keep the loser's created plan intact for
  explicit later reconciliation rather than hiding it with best-effort cleanup.
- An ID-only compare-and-swap cannot detect edits made in place to the same draft.
  Capture the approved title and blocks as an exact serialized fingerprint, then
  compare again before replacing or deleting the draft.
- On lease expiry, reconcile the available live calendar window first; accept an
  exact tile, report a moved-tile conflict, and repost only after confirmed absence.
- Block destructive regeneration when any linked workout is non-draft, scheduled,
  or claimed, and validate the entire linked set before deleting the first row.
- Treat `status === "draft"` as necessary but not sufficient before edits, moves,
  or deletes: reject persisted signup, date, or receipt evidence and any present
  scheduling claim, using one consistently ordered blocker before the first write.
- Route one sanitized user-calendar week key through creation, approval, draft
  gating, enrichment, and UI reads; fixing only tool lookups can still hide the
  local plan at a UTC week boundary.
- Stop starting external work with enough action-runtime reserve for one worst-case
  operation; report untouched work as retryable/deferred, not as a false failure.
- When an action adds secondary failure or deferred outcome counters, carry every
  category through validators, summaries, banners, and tests. Do not infer overall
  success from the primary `failed` counter or label a calendar failure as a push failure.
- A destructive preflight that derives a reverse relationship from nested array
  fields must not `collect()` an account's full history. Exhaust bounded pages and
  fail closed if the scan cannot finish, or introduce an indexed relation with a
  migration before relying on it.
- Validate both sides of every public relink path, including create and empty-slot
  assignment: protect the outgoing workout, and verify the incoming workout's
  ownership and scheduling state before the first write. An unchanged owned link
  may still accept metadata-only updates.

**Follow-up (#619).** Preserving scheduled state across the delete/relink guards
surfaced four further gaps worth pre-empting when you touch these paths:

- **Each claim phase treats an _expired_ lease differently — don't collapse them
  into one "reject expiry" rule.** The three lifecycle helpers in
  `convex/tonal/schedulingReceipts.ts` diverge exactly on `leaseExpiresAt`:
  - `acquireClaim` **reclaims** an expired lease — only an _active_ claim
    (`leaseExpiresAt > now`) returns `busy`; an expired one is overwritten and the
    caller gets `acquired`.
  - `authorizePost` **rejects** an expired lease (`leaseExpiresAt <= now` →
    retryable error), because the single POST must not fire on a stale
    authorization.
  - `completeClaim` **accepts** an expired-but-owned claim (it checks
    `claimId`/`workoutId`/`scheduledDate` ownership only), so it can persist an
    externally observed signup receipt — never add an expiry rejection there or you
    discard proof that a POST actually completed.

  The shared primitive is "is a claim _active_?" (`leaseExpiresAt > now`), not "is a
  claim present?" — but expiry is necessary, not sufficient, for the _destructive_
  delete guard, which must additionally be **phase-aware** (see the next bullet). The
  lesson: reason about _active vs. expired_ with the reclaim/reject/accept split
  above, and never let a guard block on mere claim _presence_.

- **A destructive delete guard must be phase-aware, not expiry-only.** This is the
  one place the plain active-claim predicate is insufficient. `getDeleteWorkoutPlanState`
  originally blocked on _any_ stored `tonalSchedulingClaim` regardless of expiry
  (stranding a plan forever when the lifecycle fails), but gating it on
  `leaseExpiresAt > now` _alone_ overcorrects: only an expired initial `checking`
  claim is known to predate POST authorization and is safe to reclaim/delete. An
  expired `reconciling` or `post_authorized` claim may mean the calendar tile was
  created but its receipt was never persisted, so treating it as "safe to delete"
  lets `delete_workout` remove a workout Tonal actually scheduled. Reclaim/delete
  only on an expired `checking` claim; keep ambiguous post-authorization phases as
  blockers (or reconcile them against the live calendar first), even after the lease
  expires. (Acquisition can reclaim any expired claim because it transitions to
  `reconciling` and reconciles; deletion is irreversible and cannot.)
- **Reserve atomically — a clean preflight in one transaction is stale by the next.**
  The delete preflight (query) and the external `DELETE` (action) run in separate
  transactions, so a scheduling claim or day-link acquired in between is never
  observed and the workout is deleted while weekly scheduling still references it.
  Reserve the deletion atomically in Convex and make scheduling/link mutations
  reject that reservation before issuing the external call — don't rely on a
  read-then-act gap (ties to §17's TOCTOU freshness concern).
- **Validate incoming lifecycle _status_, not only scheduling evidence.** An owned
  `failed`/`pushing`/`deleted` workout with no scheduling fields still isn't a safe
  target: approval only has a valid replacement path for `draft`/already-`pushed`
  plans, so linking a `failed` row makes every retry orphan another Tonal workout.
  Reject unsafe incoming lifecycle states alongside the scheduling-evidence check.

## 20. A statistical/threshold estimator must exclude incomplete observations and require evidence of the effect it claims — never let missing data count as a real zero

**Seen in:** #608 (2 P2 review threads)

**Problem.** The personal-MRV estimator fits a per-user set-count threshold from
observed volume-vs-strength history, then flags it `qualified_for_enforcement`
once the evidence is strong enough. Two ways the fit was driven by data that
didn't actually support it:

- **Missing/in-progress data counted as a real zero observation.** When a
  completed activity had not finished projecting its `exercisePerformance` rows,
  `setsByWeek` had no entry and the fallback recorded the muscle as having _zero_
  sets that week. The repository already tracks this state with
  `completedWorkouts.performanceSyncComplete`, but the query never read it — so
  partial/legacy syncs supplied enough false zero-volume observations to push a
  threshold to `qualified_for_enforcement` from data the user never actually
  trained at zero.
- **A "recoverable range" threshold was fit from data showing only decline.** The
  qualifying condition accepted a candidate when the higher-volume segment
  declined _more_ than the lower-volume one (e.g. medians of `-1` at/below the cap
  and `-2` above it). That difference is consistent with an unrelated downward
  trend and never demonstrates a recoverable volume ceiling, yet it could return
  `qualified_for_enforcement`. The fix requires the at-or-below-cap median strength
  change to be **nonnegative** before a fitted threshold can enforce.

**Why it matters.** An estimator that turns weak or absent evidence into an
enforceable threshold silently changes the product's behavior (here, capping a
user's programmed volume) on data that doesn't justify it — the failure looks
like a confident measurement. "No row yet" is not "measured zero," and "declines
less" is not "recovers."

**Preventive checks.**

- **Distinguish _absent_ from _zero_.** Before a fallback records a zero
  observation, confirm the underlying source is actually complete (read the
  `performanceSyncComplete`-style flag); withhold the estimate — or exclude the
  affected window entirely — until every contributing record has finished
  projecting. A missing entry must never feed a threshold as a real data point.
- **Require the fit to demonstrate the effect it enforces**, not merely a relative
  comparison. If the threshold claims a _recoverable_ range, the at-or-below-cap
  evidence must be non-declining; two declining bands stay advisory. State the
  positive condition the enforcement gate needs, and reject candidates that only
  satisfy a weaker relative one.
- Add coverage for the false-zero qualification path (incomplete-sync weeks must
  not qualify) and for the two-declining-bands case (must remain advisory).

## 21. Widening a persisted output/record shape must stay backward-compatible with rows written before the new fields existed

**Seen in:** #619 (1 P2 review thread)

**Problem.** Adding calendar scheduling to `approve_week_plan` gave its success
output two new counters (`schedulingFailed`, `deferred`) on top of the existing
`success`/`pushed`/`failed`. The chat banner extractor was tightened to require
_both_ new counters via a `hasCounts` check — but chat threads persist tool
results, so an `approve_week_plan` result emitted **before** the change has the
old shape with no new counters. `hasCounts` was `false` for those legacy rows, the
extractor returned `null`, and `ToolCallIndicator` replaced a previously confirmed
successful push with "This change could not be confirmed." The fix normalizes only
_absent/`undefined`_ new fields to legacy zero while still rejecting genuinely
malformed values (`null`, strings, fractions, negatives).

**Why it matters.** Persisted outputs (chat tool results, stored documents, cached
payloads) outlive the code that wrote them. A reader that treats a newly added
field as mandatory retroactively invalidates every record written before the
field existed — turning a display/telemetry addition into a regression on real
historical data, and (as here) flipping a confirmed success into an alarming
"couldn't confirm."

**Preventive checks.**

- When a reader/extractor gains a requirement for a **newly added** field, treat
  its _absence_ (`undefined`/missing) as the benign legacy default (usually zero /
  empty), and reserve rejection for values that are actually malformed. Absent ≠
  invalid for a field that didn't exist when the row was written.
- Before tightening a validator over a **persisted** shape, ask "what does a record
  written by the previous version look like, and does this still accept it?" — the
  same widen→migrate→narrow discipline the schema section of AGENTS.md applies to
  Convex validators applies to any reader of stored data.
- Add a regression that feeds the extractor/reader a **stored legacy-shape** record
  (old counters only) and asserts it still resolves to the correct outcome, not
  just a freshly emitted current-shape one (ties to §2 — use valid domain values
  the system can actually have persisted).

---

## How to use this log

- Before opening a PR that touches **Tonal fetch helpers, AI cost/budget paths,
  test fixtures, scheduled sweeps, React error boundaries around optional
  integrations, credential/format validators, payload transforms that
  filter/drop elements, retry/fallback error reporting, external-payload
  normalization (nullable typing, refresh vs. first-connect defaults),
  name/ID-to-catalog resolution for AI tool calls, AI tool-input (Zod) schemas
  that sit upstream of a normalize/clamp/resolve step, internal actions reachable
  without their tool schema (week-plan/cron/action→action callers), model-tier
  routing and classifier/gate changes (including per-provider tier→model
  mappings and keyword classifiers that gate tool availability), per-turn AI
  telemetry/metrics (what to count, which samples to exclude), cached/projected
  read fast-paths in front of a live source (freshness, watermark, verification),
  new async/secondary steps attached to a coach turn or sync (inheriting quota /
  deletion / terminal-outcome / ordering guards), Convex tsconfig /
  runtime-boundary changes (Node globals in default-runtime files), scheduling
  claim/lease and delete/relink guards (active-vs-expired consistency,
  cross-transaction reservation, incoming lifecycle status), statistical/threshold
  estimators (excluding incomplete data, requiring evidence of the enforced
  effect), or readers/validators over a widened persisted output shape (backward
  compatibility with pre-existing rows)**, skim the matching section above.
- When a review surfaces a _new_ recurring, legitimate gap (not stylistic, not
  one-off), add an entry here with the PR reference so the next agent inherits
  the lesson.
