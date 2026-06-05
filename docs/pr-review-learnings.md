# PR Review Learnings

Last reviewed: 2026-06-05

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

## 7. When you filter a payload list before an external push, preserve its invariants

**Seen in:** #440 (3 review threads: one P2, two P3)

**Problem.** `buildTonalWorkoutSets` started dropping synthetic movements (e.g.
injected `Rest` sentinels) from the set list it builds for Tonal. Filtering a
list right before it leaves for an external API broke three invariants that the
rest of the code still assumed held:

- **Empty result not guarded.** A rest-only block now filtered down to `[]`, but
  the push path still POSTed that empty `sets` array to `/v6/user-workouts`.
  Tonal answers with a misleading 400, so `createWorkout` recorded a _failed_
  plan after a remote round-trip instead of failing fast with a clear local
  error. (The estimate path already rejected empty payloads — the push path had
  drifted out of sync with it.)
- **Derived count went stale.** `createWorkout` reported `setCount` from a
  _separate, unfiltered_ `expandBlocksToSets(blocks)` calculation, so a block
  with 3 work sets + 3 rest sentinels told the user/LLM "6 sets pushed" while
  only 3 reached Tonal.
- **Structural marker dropped.** If a block led with a synthetic movement,
  filtering removed the only set flagged `blockStart: true`, so the first _real_
  set shipped with `blockStart: false` and the Tonal payload's block boundaries
  no longer matched the internally validated block structure.

**Why it matters.** A filter applied at the last mile silently desynchronizes
every sibling computation that was written against the unfiltered list —
emptiness guards, counts shown to the user, and positional/structural flags.
The failures surface as confusing remote errors and overstated success messages,
not as a local validation failure where they'd be obvious.

**Preventive checks.**

- After filtering a list destined for an external API, **guard the empty case
  before constructing/sending the payload** and fail with a clear local error
  (or a handled `{ error }` return matching the function's contract) rather than
  letting the remote API reject it.
- **Recompute every derived value from the filtered list**, not from a parallel
  unfiltered source. Grep for other counts/lengths computed off the same input
  (`expandBlocksToSets`, `.length`) and point them at the post-filter array.
- **Re-establish positional/structural markers** (`blockStart`, first/last
  flags, indices) after removing elements, or reject inputs whose synthetic
  elements occupy a structurally significant slot.
- Mirror guards that already exist on a sibling path (here, the estimate path's
  empty-payload rejection) so the two paths can't drift.

## 8. Keep alerts accurate and emit them before long awaits that the action cap can kill

**Seen in:** #434 (2 review threads, both P2)

**Problem.** A circuit-breaker change added richer fallback context to the
breaker-open alert, but introduced two observability gaps on the retry/fallback
path:

- **Generic error class clobbered the real one.** When the fallback attempt
  ended terminally for a _known_ class (BYOK, quota, other non-transient
  provider errors), the alert reported a generic `TerminalFallbackAttemptFailure`
  instead of the concrete class `streamWithRetry` had already classified —
  making the alert least accurate exactly when fallback failed for a diagnosable
  reason. Fix: carry `errorClass` through `AttemptOutcome` and surface it for
  both primary and fallback terminal outcomes.
- **Alert awaited behind a cap-bounded operation.** The breaker-open
  notification was delayed until _after_ the final fallback attempt finished.
  With each attempt budgeting 180s under Convex's 600s action cap, two primary
  timeouts plus the fallback can run close enough to the cap that the action is
  killed before the notification is ever sent — even though the breaker had
  already opened. Fix: emit a minimal breaker-open notification (`Fallback:
pending`) _before_ awaiting fallback, then send the fallback outcome
  separately.

**Why it matters.** An alerting change is only as good as the alert that
actually arrives. Replacing a classified error with a generic sentinel destroys
the signal operators need; deferring the emission behind a cap-bounded await
means the highest-severity event (breaker open after repeated failure) is the
one most likely to never fire. Both regress observability on precisely the
failure paths the alert exists to cover.

**Preventive checks.**

- **Thread the concrete error class through outcome types**; don't overwrite an
  already-classified terminal error with a generic "fallback failed" sentinel in
  the notification layer.
- **Emit critical notifications before, not after, a long await** that can hit
  the Convex action cap (see also Learning #4). Send a minimal "in progress"
  alert eagerly, then a follow-up with the outcome — or send the outcome from a
  best-effort `finally`.
- Add regression coverage asserting (a) the terminal alert carries the real
  class, and (b) the breaker-open notification is emitted _before_ the final
  fallback attempt is awaited.

## 9. Keep external-payload types honest, and don't let refresh paths clobber good data with normalized defaults

**Seen in:** #429 (2 review threads: one Major, one P2)

**Problem.** Tonal sub-account profiles return `null` for `heightInches`,
`weightPounds`, and `workoutsPerWeek`, and `toUserProfileData` normalizes those
to `0` (`?? 0`) so first-time connect validation passes. Two issues followed:

- **Type lied about the payload.** `TonalUser` in `convex/tonal/types.ts`
  declared those fields as non-nullable `number`, even though the runtime
  normalizer and a `profileData.test.ts` case both already handled `null`. The
  interface told every downstream reader the values were always present, hiding
  the real `number | null` shape. Fix: declare them `number | null` to match the
  payload.
- **Refresh clobbered real measurements with zeros.** Normalizing `null → 0` is
  fine for a brand-new connect, but `updateProfileData` replaces the _whole_
  stored `profileData`. On an existing-user refresh/backfill where Tonal returned
  `null`, a user who previously had real height/weight/frequency was downgraded
  to `0`, and those zeros then leaked into the AI context (`0"/0lbs`, `0x/week`).
  Fix: pass the existing stored profile into the mapper and only fall back to `0`
  when _both_ the new payload and the stored value are missing.

**Why it matters.** A type that's narrower than the real payload pushes every
`null`-handling bug downstream and out of sight of the compiler. And a refresh
that overwrites known-good state with a normalized default is a data-loss bug
that masquerades as a successful sync — the corruption only shows up later in a
derived surface (the AI coach reading `0"` height).

**Preventive checks.**

- **Model external-payload types from real responses, including nullable
  fields.** If a normalizer applies `?? default`, the source type almost
  certainly needs `| null`; keep the interface honest rather than asserting
  presence the wire never guarantees.
- **Separate "validate a fresh value" from "merge into existing state."**
  A `null → default` normalization that's correct on first write can be
  destructive on refresh/backfill. When a path replaces a whole stored record,
  preserve prior non-null fields and only apply the default when no prior value
  exists.
- Add regression coverage asserting a refresh with a `null` payload field
  **preserves** the previously stored value rather than zeroing it.

---

## How to use this log

- Before opening a PR that touches **Tonal fetch helpers, AI cost/budget paths,
  test fixtures, scheduled sweeps, React error boundaries around optional
  integrations, credential/format validators, payloads built for an external API
  (especially when filtering a list before the push), alert/notification emission
  on retry/fallback paths, or external-payload types and profile refresh/merge
  logic**, skim the matching section above.
- When a review surfaces a _new_ recurring, legitimate gap (not stylistic, not
  one-off), add an entry here with the PR reference so the next agent inherits
  the lesson.
