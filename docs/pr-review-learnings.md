# PR Review Learnings

Last reviewed: 2026-06-03

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

## 7. Refresh/backfill must not overwrite known-good values with placeholders, and API types must model the real (nullable) payload

**Seen in:** #429 (2 review threads, one P2)

**Problem.** A mapper was added to normalize a Tonal sub-account profile, where
the payload can return `null` for `heightInches`, `weightPounds`, and
`workoutsPerWeek`. Two distinct gaps:

- **Type drift.** `convex/tonal/types.ts` declared those fields as non-nullable
  `number`, yet `toUserProfileData` already coerced them with `?? 0` and a test
  fed them `null`. The `?? 0` was a tell that the upstream type was wrong; the
  declared type lied about the payload, so callers had no type-level signal that
  the values could be absent.
- **Clobbering real data with a placeholder.** On an _existing-user refresh or
  backfill_, a `null` from Tonal was coerced to `0`, and
  `userProfiles.updateProfileData` replaces the whole stored `profileData` — so a
  user who previously had real height/weight/frequency got silently downgraded to
  `0`. Those zeros then flowed into the AI coaching context (`0"/0lbs`,
  `0x/week`), corrupting programming inputs. The `?? 0` fallback is correct for
  _first-time connect validation_ but wrong for a refresh that should preserve
  prior measurements when the latest payload merely says "unknown."

**Why it matters.** A normalization that maps "unknown" to a concrete sentinel
(`0`, `""`) on a path that overwrites stored state turns a transient gap in the
upstream payload into permanent data loss — and here the corrupted values feed
directly into AI programming decisions. A type that doesn't model `null` hides
the whole class of bug from the type checker.

**Preventive checks.**

- When the API can return `null`/absent for a field, model it as `T | null` in
  the response type. Treat a `?? <default>` or `as` coercion in a mapper as a
  prompt to check whether the source type should be widened to match the real
  payload.
- Distinguish **validation-time defaulting** (first connect: a sentinel is fine)
  from a **refresh/backfill that overwrites stored state**. On the overwrite
  path, pass the existing stored value into the mapper and fall back to the
  placeholder only when _both_ the new payload and the stored value are missing —
  never let "unknown now" erase "known before."
- Add regression coverage that a nullable refresh **preserves** prior non-null
  values (assert the stored value survives), not just that the mapper coerces a
  standalone `null`.

## 8. Carry the concrete classification through outcome/alert types, and emit state-transition notifications before awaiting more long-running work

**Seen in:** #434 (2 review threads, both P2)

**Problem.** A PR added fallback context to the circuit-breaker alert, but the
alert path had two gaps:

- **Generic sentinel masked the real class.** When the fallback attempt ended in
  a terminal failure (`{ done: true, success: false }` — used for BYOK, quota,
  and other non-transient provider errors), the breaker alert always reported a
  generic `TerminalFallbackAttemptFailure` instead of the concrete error class
  the attempt had already determined. The "context" was inaccurate exactly when
  it mattered — on a known-class failure. Fixed by carrying `errorClass` through
  `AttemptOutcome` so the notification reports the real class for both primary and
  fallback terminal outcomes.
- **Critical notification deferred behind a long await.** The breaker-open alert
  was emitted only _after_ awaiting the final fallback attempt. With
  `convex/ai/resilience.ts` budgeting 180s/attempt under Convex's 600s action
  cap, two primary timeouts plus the fallback can run close to the cap, so the
  action may be killed before reaching the notification — even though the breaker
  had _already_ opened. Fixed by emitting a minimal breaker-open notification
  (`Fallback: pending`) before starting the final fallback, then sending the
  fallback outcome separately.

**Why it matters.** A telemetry/alert path is most valuable on failure; replacing
the determined classification with a generic sentinel discards the signal
operators need precisely when an incident is happening. And a notification that
fires only after more long-running work can be lost to the action cap on exactly
the slow, multi-retry turns the breaker exists to flag — the state changed but no
one was told. (This is the notification analogue of §4's sweep-timing trap: both
fail on the slow/retried path because they assume work completes before the cap.)

**Preventive checks.**

- When enriching an alert/telemetry record with "context," carry the concrete
  classification (error class, finish reason) through the outcome type end to
  end. Don't collapse it to a generic constant at the reporting boundary — assert
  in a test that a known-class terminal failure surfaces that class, not the
  sentinel.
- Emit critical state-transition notifications (breaker-open, escalation,
  alarm) **as soon as the state changes**, before awaiting further long-running
  attempts. Add the later outcome as a separate, best-effort notification (or from
  a `finally`), so a subsequent action-cap kill can't swallow the transition.
- For any notify-after-await on an AI/provider path, sanity-check the worst-case
  timeline against `CONVEX_ACTION_MAX_MS` (see §4); if the await chain can
  approach the cap, move the notification ahead of it.

---

## How to use this log

- Before opening a PR that touches **Tonal fetch helpers, AI cost/budget paths,
  test fixtures, scheduled sweeps, React error boundaries around optional
  integrations, credential/format validators, profile refresh/backfill
  normalizers, or circuit-breaker/alert paths**, skim the matching section
  above.
- When a review surfaces a _new_ recurring, legitimate gap (not stylistic, not
  one-off), add an entry here with the PR reference so the next agent inherits
  the lesson.
