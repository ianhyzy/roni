# PR Review Learnings

Last reviewed: 2026-06-15

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

- **Order match precedence explicitly and check exact before trusting an ID:**
  exact full `name` → exact `shortName` alias → valid/well-known ID, and verify
  an exact name match _before_ accepting a supplied ID so a stale/copied ID can't
  win over the correct name. Reject ID/name mismatches rather than letting the ID
  win — resolution sits between a fallible LLM and an external write, so "resolve
  to something plausible" is the wrong default.
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

---

## How to use this log

- Before opening a PR that touches **Tonal fetch helpers, AI cost/budget paths,
  test fixtures, scheduled sweeps, React error boundaries around optional
  integrations, credential/format validators, payload transforms that
  filter/drop elements, retry/fallback error reporting, external-payload
  normalization (nullable typing, refresh vs. first-connect defaults),
  name/ID-to-catalog resolution for AI tool calls, AI tool-input (Zod) schemas
  that sit upstream of a normalize/clamp/resolve step, or model-tier routing and
  classifier/gate changes (including per-provider tier→model mappings)**, skim the
  matching section above.
- When a review surfaces a _new_ recurring, legitimate gap (not stylistic, not
  one-off), add an entry here with the PR reference so the next agent inherits
  the lesson.
