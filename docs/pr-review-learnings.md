# PR Review Learnings

Last reviewed: 2026-06-04

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

## 7. When filtering a payload before an external API boundary, handle empty, recount, and re-anchor structure

**Seen in:** #440 (3 review threads — one P2/Major, two P3)

**Problem.** The Tonal push path gained `buildTonalWorkoutSets`, which strips
well-known synthetic movements (the internal Rest sentinel) out of the set list
before crossing the `POST /v6/user-workouts` boundary. The internal block
validation still _accepts_ the Rest sentinel, so synthetic-only or
synthetic-leading blocks can reach the filter. Stripping them introduced three
distinct gaps:

- **Empty payload not rejected.** A rest-only block filtered down to `[]`, but
  the code still POSTed the empty set list. Tonal then failed with a misleading
  downstream 400 and `createWorkout` recorded a failed plan, instead of failing
  fast with a clear local validation error (the estimate path already guarded
  this; the push path didn't).
- **Derived count drifted from the payload.** `createWorkout` still reported
  `setCount` from a _separate_ unfiltered `expandBlocksToSets(blocks)` call, so
  "3 work sets + 3 rest sentinels" reported 6 sets pushed while only 3 were
  actually sent — the user/LLM-visible success overstated the result.
- **Structural marker lost.** If a block _started_ with a synthetic movement,
  filtering removed the only set marked `blockStart: true`, so the first real set
  of that block crossed the boundary with `blockStart: false` — the outbound
  block boundaries no longer matched the internally validated structure.

**Why it matters.** A transform that drops elements just before an external call
quietly breaks three invariants at once: the call can be made with nothing to do,
any count computed from the _pre-filter_ data lies about what was sent, and any
positional/structural marker the filter happened to remove is silently dropped.
All three surface as confusing remote errors or wrong success metadata rather
than a clear local failure.

**Preventive checks.**

- After filtering, **guard the empty result** and fail with a clear local error
  (or handled `{ error }`) _before_ constructing/sending the payload — never let
  the remote API reject an empty request on your behalf.
- Compute any **derived count or metadata from the filtered payload**, not from a
  separate pre-filter calculation, so success messages match what was sent.
- If the filter can remove an element carrying a **positional/structural marker**
  (block start, "first item", ordering index), re-derive that marker on the
  filtered output (e.g. re-mark the first remaining set in each block).
- Add coverage for the all-synthetic (empty) case and the synthetic-leading case,
  not just the happy path.

## 8. Don't clobber existing stored values when normalizing nullable upstream fields on a replace-write

**Seen in:** #429 (1 P2 thread, plus a type-honesty Major)

**Problem.** Tonal sub-account profiles can return `null` for `heightInches`,
`weightPounds`, and `workoutsPerWeek`, but the `profileData` validator requires
numbers, so `toUserProfileData` normalized `null → 0` to pass validation. That
default is correct for first-time connect, but `userProfiles.updateProfileData`
**replaces the whole stored `profileData` object**. On a refresh or backfill, a
user who previously had real height/weight/frequency was downgraded to `0` when
the latest Tonal payload merely reported those fields as unknown — and those
zeros then flowed into the AI context as `0"/0lbs`, `0x/week`. Separately, the
`TonalUser` type declared the fields as non-nullable `number` while the code
already handled `null` and tests fed `null`, so the type lied about the payload.

**Why it matters.** A "missing → default" rule that is safe on _create_ becomes
destructive on a _replace-write_ refresh path: it overwrites previously-known
good data with placeholders whenever the upstream source happens to omit a value.
The corruption is silent (validation passes) and propagates into downstream
consumers that trust the stored values.

**Preventive checks.**

- Distinguish **create vs. refresh/replace** when defaulting nullable upstream
  fields. On a path that replaces the whole record, pass the existing stored
  values into the mapper and fall back to a default only when _both_ the new
  payload and the stored value are missing — never let "unknown upstream" erase
  "previously known."
- Keep the **type honest about nullability**: if the runtime normalizes `null`,
  the source type (`TonalUser`) should be `number | null`, not `number`, so the
  normalization site is visible and type-checked rather than relying on a silent
  `?? 0`.
- Add a regression test that seeds prior measurements, refreshes with a
  null-bearing payload, and asserts the stored values are **preserved** (not
  zeroed).

## 9. Keep error classification concrete through resilience wrappers, and notify before long awaits that can hit the action cap

**Seen in:** #434 (2 P2 threads)

**Problem.** The AI circuit-breaker wrapper added fallback context to its Discord
outage alert, but two gaps undercut it:

- **Terminal class collapsed to a placeholder.** When a fallback attempt ended
  with `runAttempt` returning `{ done: true, success: false }` — the path used in
  `convex/ai/resilience.ts` for BYOK, quota, and other non-transient provider
  errors _after it had already recorded the real class_ — the alert always
  reported a generic `TerminalFallbackAttemptFailure`. The new context was least
  accurate exactly when fallback failed for a known reason.
- **Notification deferred past the action cap.** The breaker-open alert was
  delayed until after the final fallback finished. With each attempt budgeting
  180s under Convex's 600s action cap, two primary timeouts plus the fallback can
  run close enough to the cap that the action is killed before reaching the
  notification — even though the breaker had already opened.

**Why it matters.** Resilience/observability code is the last thing watching when
everything else is failing. If it discards the concrete error class it already
computed, the alert misleads operators precisely during a real outage; if it
saves the alert for _after_ a long await, the action can die before the alert is
ever sent, so the outage looks like silence.

**Preventive checks.**

- Carry the **concrete terminal error class** through the retry/fallback wrapper
  (e.g. in `AttemptOutcome.errorClass`) and report it for both primary and
  fallback terminal outcomes — don't overwrite an already-known class with a
  generic placeholder.
- Emit the **outage/breaker notification before awaiting** a long final fallback
  (with `Fallback: pending`), then send a follow-up completion notification if the
  action reaches the fallback result. Assume any single await can be killed by the
  600s action cap (see learning #4 for the cap-derived timing rule).
- Add coverage asserting the notification fires _before_ the final fallback
  attempt, and that terminal failures report their real class.

---

## How to use this log

- Before opening a PR that touches **Tonal fetch helpers, AI cost/budget paths,
  test fixtures, scheduled sweeps, React error boundaries around optional
  integrations, credential/format validators, payload transforms at an external
  API boundary, nullable-field normalization on replace-writes, or
  resilience/notification paths**, skim the matching section above.
- When a review surfaces a _new_ recurring, legitimate gap (not stylistic, not
  one-off), add an entry here with the PR reference so the next agent inherits
  the lesson.
