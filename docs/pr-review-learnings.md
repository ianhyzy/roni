# PR Review Learnings

Last reviewed: 2026-06-07

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

## 7. When a transform drops elements from an outbound payload, propagate the filtering everywhere

**Seen in:** #440 (3 review threads — one P2 plus two P3)

**Problem.** `buildTonalWorkoutSets` started filtering synthetic movements (e.g.
a rest-only sentinel) out of the sets it sends to Tonal. The filtering was
applied to the payload but **not** to the surrounding logic that assumed the
unfiltered list:

- **Empty result not rejected.** When the input was only synthetic movements,
  the helper returned `[]`, and `pushWorkoutToTonal` still POSTed an empty set
  list to `/v6/user-workouts`. Tonal answers with a misleading 400, so a clear
  local validation error became a recorded failed plan after a remote round-trip.
- **Stale count.** `createWorkout` reported `setCount` from a _separate_
  unfiltered `expandBlocksToSets(blocks)` calculation, so the user/LLM-visible
  success result overstated how many sets were actually pushed (3 work + 3 rest
  sentinels reported 6 while only 3 posted).
- **Broken structural invariant.** If a block _started_ with a synthetic
  movement, filtering removed the only set marked `blockStart: true`, so the
  first real set of that block was sent with `blockStart: false` — a Tonal
  payload whose block boundaries no longer matched the validated block structure.

**Why it matters.** A filter applied in one spot but not the dependent
calculations produces payloads that are internally inconsistent: empty pushes
that fail remotely instead of locally, counts that lie, and structural flags
(block starts) that drift from the real data. Each gap surfaces far from the
filter, at the remote API boundary or in user-facing output.

**Preventive checks.**

- After adding a filter to an outbound payload, **guard the empty case** before
  constructing/sending it — fail fast locally (`return { error }` to match the
  handler's contract, or throw) rather than letting the remote API reject it.
- Derive any **count, size, or summary** the caller reports from the _same
  filtered list_ that becomes the payload, not from a parallel unfiltered
  computation.
- Re-establish **structural invariants** (block starts, ordering flags, indices)
  on the filtered list — e.g. re-mark the first remaining set in each block as
  `blockStart` — or reject inputs that would place a dropped element in a
  structurally significant position.
- Add coverage for the all-synthetic (fully-filtered-to-empty) input and for a
  block whose leading element is filtered out.

## 8. Model upstream-nullable fields as nullable, and never clobber stored values on a null refresh

**Seen in:** #429 (1 P2 review thread plus a typing fix)

**Problem.** Tonal sub-account profiles can return `null` for `heightInches`,
`weightPounds`, and `workoutsPerWeek`, but `TonalUser` typed them as
non-nullable `number` while `toUserProfileData` already normalized `null` to `0`
(`?? 0`). Two distinct gaps:

- **Type lied about the payload.** The interface claimed the fields were always
  present even though the mapper and a test both handled `null`.
- **Refresh clobbered real data.** Normalizing `null → 0` is fine for first-time
  connect validation, but `updateProfileData` replaces the _whole_ stored
  `profileData`. On a refresh/backfill where Tonal returned `null`, a user who
  previously had real height/weight/frequency was silently downgraded to `0` —
  and those zeros then flowed into the AI context (`0"/0lbs`, `0x/week`).

**Why it matters.** A `?? defaultValue` normalization is lossy: "value is
unknown right now" is not the same as "value is zero." When the destructive
default lands on a full-document overwrite, a transient null from upstream
permanently destroys good data the user already had.

**Preventive checks.**

- Type fields to **match the real upstream payload** (`number | null`), not the
  shape you wish it had — cross-check against the mapper's `??`/optional handling
  and any test that injects `null`.
- Separate **first-write validation defaults** from **refresh/backfill merges.**
  On refresh, pass the existing stored value into the mapper and only fall back
  to the default when _both_ the new payload and the stored value are missing —
  don't let a null refresh overwrite a previously-good measurement.
- Audit every caller of a "replace the whole document" mutation: if upstream can
  send partial/null data, the merge must preserve prior non-null fields.
- Add a regression test that seeds a real measurement, refreshes with a null
  payload, and asserts the stored value is **preserved** (not zeroed).

## 9. Resilience telemetry must carry the real error class and notify before long final attempts

**Seen in:** #434 (2 P2 review threads)

**Problem.** New circuit-breaker fallback context had two timing/accuracy gaps:

- **Generic terminal class.** When a fallback attempt ended with
  `{ done: true, success: false }` (the path used for BYOK, quota, and other
  non-transient provider errors _after_ the real class was recorded), the
  circuit-breaker alert always reported a generic
  `TerminalFallbackAttemptFailure` instead of the concrete error class —
  inaccurate exactly when knowing the class matters most.
- **Notification stuck behind the final fallback.** The breaker-open alert was
  delayed until after the fallback attempt finished. With each attempt budgeting
  180s under Convex's 600s action cap, two primary timeouts plus the fallback can
  run close enough to the cap that the action is killed _before_ the
  notification fires — even though the breaker is already open.

**Why it matters.** Observability added for failure paths must survive the
failure path. An alert that loses the error class, or that never sends because
the action died first, is worst precisely on the slow/retried turns it exists to
illuminate.

**Preventive checks.**

- Carry the **concrete error class** through `AttemptOutcome` (and fallback
  outcomes) to the notification — don't substitute a generic placeholder for a
  class that was already classified upstream.
- Emit operator notifications for a state transition (breaker open) **before**
  awaiting any long-running final attempt that could be killed by the
  `CONVEX_ACTION_MAX_MS` cap; send the attempt's _outcome_ separately (or from a
  best-effort `finally`) once it completes. Mark the pre-send as `pending`.
- When summing attempt budgets (`primary + primary + fallback`) against the
  action cap, confirm a notification or persistence side-effect that must happen
  can still fire within the remaining time.
- Add regression coverage asserting both invariants: the terminal class reaches
  the alert, and the breaker-open notification is sent _before_ the final
  fallback attempt starts.

---

## How to use this log

- Before opening a PR that touches **Tonal fetch helpers, AI cost/budget paths,
  test fixtures, scheduled sweeps, React error boundaries around optional
  integrations, credential/format validators, outbound-payload transforms that
  filter elements, profile/data refresh merges over nullable upstream fields, or
  AI resilience telemetry/notification paths**, skim the matching section above.
- When a review surfaces a _new_ recurring, legitimate gap (not stylistic, not
  one-off), add an entry here with the PR reference so the next agent inherits
  the lesson.
