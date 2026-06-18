# PR Review Learnings

Last reviewed: 2026-06-18

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

## 10. Resolving an LLM-supplied name/ID to a catalog entry that drives an external write must prefer the exact name, never auto-substitute a fuzzy match, and not let new schema requirements block exempt sentinels

**Seen in:** #465 (4 review threads, all P2)

**Problem.** `create_workout` was changed to require a `name` for each movement
and resolve it against the Tonal catalog (repairing missing/wrong
`movementId`s). The resolver (`convex/tonal/movementResolve.ts`) had four gaps,
each of which could silently push the **wrong** exercise to the user's Tonal
workout — or block a valid call:

- **A supplied ID won over the requested name.** When both `name` and
  `movementId` were present, a valid-but-stale ID resolved immediately and the
  name was never checked. An LLM that reuses a real ID from another exercise
  while giving the correct new name would silently push the wrong movement.
- **A broad fuzzy match was auto-substituted.** Non-catalog names fell through to
  `matchesNameSearchStrict`, which matches if any 3+ character word appears in a
  movement name, then pushed the sole match. `Decline Push-up` could resolve to
  `Standing Decline Chest Press` and be pushed silently.
- **shortName aliases shadowed exact full names.** When the requested `name`
  exactly equalled one movement's full `name` but also another movement's
  `shortName`, the resolver merged both rows and returned `ambiguous`, blocking a
  call whose full-name match was actually unambiguous.
- **A newly-required field rejected an exempt sentinel.** Making `name` required
  in the tool's Zod schema rejected the synthetic `Rest` sentinel (supplied by
  `movementId` only, catalog-exempt, can't come from `search_exercises`) before
  `resolveMovement`'s well-known-ID path could run.

**Why it matters.** Resolution sits between a fallible LLM and an external
side-effect (a real workout pushed to the user's machine). "Resolve to something
plausible" is the wrong default: a stale ID, a partial-word collision, or an
alias shadow becomes a wrong exercise the user actually trains on, with no error
surfaced. And tightening an input schema to enable a new path can simultaneously
break an existing exempt path if you don't account for sentinels.

**Preventive checks.**

- **Verify the exact name before trusting a supplied ID.** When both name and ID
  arrive, resolve/confirm the exact full-name match first; only trust the ID when
  no name is given (or the name confirms it). Reject ID/name mismatches rather
  than letting the ID win.
- **Only auto-resolve on exact matches.** Restrict silent auto-substitution to
  exact full-name (then exact shortName) matches plus known/well-known IDs. Return
  any fuzzy/partial-word match as an `ambiguous` **candidate** for the model to
  confirm — never push it.
- **Order the match tiers explicitly:** exact full `name` → exact `shortName`
  alias → valid/well-known ID. Check full names first so an alias collision can't
  turn an unambiguous full-name match into `ambiguous`.
- **When you make a field required to enable a new path, enumerate the inputs that
  legitimately lack it** (synthetic/sentinel/catalog-exempt values like `Rest`)
  and keep the schema (and the resolver's not-found message) from rejecting them —
  make the field optional and special-case the exempt IDs.
- Add coverage for each: stale-id-vs-correct-name, broad-fuzzy-not-substituted,
  full-name-over-shortName, and the sentinel/not-found path.

## 11. A model-tier routing change has a primary path and a fallback path — reason about both, and reroute the one buggy branch instead of removing the whole gate

**Seen in:** #469 (4 review threads, all P2)

**Problem.** A bug where short workout requests routed to the flash-lite
`router` tier (which doesn't reliably drive `search_exercises → create_workout`)
prompted a fix that removed the whole pre-routing classifier gate so chat turns
always started on the `chat` tier. Two separate regressions fell out, plus a
fallback-path trap:

- **Removing the gate dropped an unrelated branch.** The same classifier also
  routed `complex` prompts ("program a week", "build a plan") to the
  `programming` tier. Deleting it meant BYOK Claude/OpenAI users' explicit
  planning requests now started on the cheaper `chat` tier (Sonnet / GPT-mini)
  and only escalated _retrospectively_ in `prepareStep` after a programming tool
  had already run — weakening exactly the requests the programming tier is
  reserved for.
- **The fallback tier was a separate decision the primary fix didn't touch.**
  `selectCoachTierRoute` derives the fallback with `getFallbackTier(primaryTier)`,
  and `getFallbackTier("chat")` is the `router` (flash-lite) tier. On
  circuit-open / transient-timeout paths, `streamWithRetry` runs the **fallback**
  agent for the same turn — so a short workout request whose primary `chat`
  attempt failed would still be handled by flash-lite, reintroducing the exact
  no-workout behavior the change was meant to fix.
- **...but changing the fallback tier broke a different provider.** Trying to fix
  that by making `getFallbackTier("chat")` return `programming` made the default
  house-key Gemini policy (where `chat` and `programming` both resolve to
  `gemini-2.5-flash`) re-run the _same_ model on fallback, dropping the distinct
  `flash-lite` fallback that protected against a flash outage / circuit trip.
  Tool-capability and distinct-fallback-model can't both hold on Gemini without a
  model-policy change.

The accepted resolution was **surgical**: keep the classifier, keep
`complex → programming`, and reroute only the `trivial` branch to the `chat`
tier — leaving the fallback tier untouched.

**Why it matters.** Tier routing is two decisions, not one — the primary tier and
the fallback tier the retry/circuit path uses — and they interact with per-provider
model policy. A change that improves the primary path can silently degrade the
fallback path (or vice versa), and ripping out a multi-branch classifier to fix
one branch takes the other branches' behavior with it. The damage lands on the
exact slow/failed/planning turns the tiers exist to protect.

**Preventive checks.**

- **Prefer the surgical reroute.** When one branch of a classifier/router is
  wrong, change that branch — don't delete the whole gate. Enumerate every branch
  the gate controls (`trivial`, `complex`, …) and confirm each still routes as
  before.
- **Trace both the primary and the fallback tier for the changed route.** Check
  what `getFallbackTier(primaryTier)` resolves to and remember the fallback agent
  runs the _same turn_ on circuit-open/timeout — a primary-only fix can leave the
  failure path on the tier you were escaping.
- **Resolve tiers per active provider/model policy before concluding.** A fallback
  that looks distinct in the abstract (`chat` vs `programming`) can collapse to the
  same model under a provider's policy (Gemini flash == flash), erasing the
  fallback's value. Decide consciously between a tool-capable fallback and a
  distinct-model fallback when a provider can't offer both.
- Add a regression assertion for the invariant you're protecting (e.g. the default
  route's `fallbackTier` is never `router`, or `complex` still maps to
  `programming`) so the routing can't silently regress.

## 12. Keep tool-input validation permissive enough for the downstream normalizer that repairs known-bad AI output to actually run

**Seen in:** #460 (1 P2 review thread)

**Problem.** #447's failure mode was the coach emitting `reps: 0`/negative or
`duration: 0`/negative. The fix added a `positiveOr` clamp in `buildSet` /
`buildTonalWorkoutSets` and routed the retry and week-plan push paths through it.
But the standalone `create_workout` tool still declared these fields with Zod
`.positive()`, so the agent runtime rejected the malformed tool call **before
`execute` ran** — the new clamp never got the chance to repair the one-off push,
which kept failing on the exact #447 input. The fix was to make the schema
permissive again (`int().optional()`) and let the `positiveOr` normalization be
the single place that repairs non-positive reps/duration before the Tonal push.

**Why it matters.** When you add a normalizer/repair step to absorb a known class
of bad LLM output, a strict validator sitting _upstream_ of it silently defeats it
on whichever path still validates first. The feature looks fixed (the common
helper works, tests pass) while the originally-reported path still bounces — the
same shape as §10's "newly-required field rejects an exempt sentinel" and §6's
validator-rejects-the-real-format trap.

**Preventive checks.**

- When a downstream step exists specifically to repair a value (clamp non-positive
  reps, inject a default, coerce a shape), keep the **tool/input schema permissive
  for that field** (`int().optional()`, not `.positive()`) and let the normalizer
  be the single enforcement point — don't enforce the invariant twice with the
  strict copy winning first.
- After adding a repair step, **list every entry path** to the external write
  (retry, week-plan, standalone tool call) and confirm each reaches the
  normalizer; a fix applied to the shared helper still misses a path whose schema
  rejects the input earlier.
- Add a regression test that drives the **standalone tool path** with the
  originally-reported bad value and asserts it is repaired and pushed, not
  rejected before `execute`.

---

## How to use this log

- Before opening a PR that touches **Tonal fetch helpers, AI cost/budget paths,
  test fixtures, scheduled sweeps, React error boundaries around optional
  integrations, credential/format validators, payload transforms that
  filter/drop elements, retry/fallback error reporting, external-payload
  normalization (nullable typing, refresh vs. first-connect defaults),
  name/ID-to-catalog resolution that drives an external write, model-tier routing
  (primary vs. fallback tier, per-provider model policy), or tool-input
  validation that sits upstream of a normalizer/repair step**, skim the matching
  section above.
- When a review surfaces a _new_ recurring, legitimate gap (not stylistic, not
  one-off), add an entry here with the PR reference so the next agent inherits
  the lesson.
