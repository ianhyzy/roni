# PR Review Learnings

Last reviewed: 2026-06-06

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

## 7. When filtering elements out of an outbound payload, reject empties, preserve structural markers, and re-derive counts from the filtered list

**Seen in:** #440 (3 review threads — one P2, two P3)

**Problem.** `buildTonalWorkoutSets` started dropping synthetic "rest" sentinel
movements from the sets list before POSTing to the Tonal `/v6/user-workouts`
endpoint. Filtering a payload in place introduced three distinct gaps:

- **Empty result still sent.** A rest-only block filtered down to `[]`, but the
  push path forwarded the empty set list to Tonal. The estimate path already
  rejected empties (Tonal returns a misleading 400); the push path didn't, so
  `createWorkout` recorded a _failed_ plan after a remote round-trip instead of
  failing fast with a clear local error.
- **Reported count diverged from what was sent.** `createWorkout` computed
  `setCount` from a _separate, unfiltered_ `expandBlocksToSets(blocks)` call, so
  the user/LLM-visible success result overstated how many sets were actually
  pushed (e.g. "6 sets" reported when 3 work sets + 3 rest sentinels filtered
  down to 3 posted).
- **Structural marker lost.** If a block _started_ with a synthetic movement,
  filtering removed the only set flagged `blockStart: true`, so the first real
  set of that block went out as `blockStart: false` — the outbound block
  boundaries no longer matched the internally validated block structure.

**Why it matters.** A filter applied late, just before serialization, silently
breaks invariants the rest of the system assumed held: non-empty payloads,
counts that reflect what was sent, and structural flags positioned correctly.
Each gap surfaces only on the specific shapes that trigger filtering, so normal
inputs look fine while edge cases produce remote failures, misreported results,
or corrupt payloads.

**Preventive checks.**

- After filtering, **guard the empty case before serializing/sending** — fail
  fast with a local error (or a handled `{ error }` matching the function's
  return contract) rather than letting the remote API reject it.
- **Derive any reported metadata (counts, summaries) from the same filtered
  output** that is actually sent, not from a parallel unfiltered computation.
- **Re-establish structural invariants after filtering** — re-mark the first
  remaining element in each group (e.g. `blockStart`), or reject synthetic
  elements in positions that carry such markers.
- Add coverage for the shapes that trigger filtering: an all-synthetic input
  (→ empty guard), a mixed input (→ count matches), and a leading-synthetic
  group (→ marker preserved).

## 8. Carry the concrete failure class through retry/fallback outcomes, and emit alerts before long awaits near the action cap

**Seen in:** #434 (2 review threads, both P2)

**Problem.** PR #434 added richer context to circuit-breaker alerts, but the new
plumbing had two gaps on the fallback path:

- **Generic class clobbered the real one.** When a fallback attempt ended via
  `runAttempt` returning `{ done: true, success: false }` (the path used for
  BYOK/quota/other non-transient provider errors after the real class was already
  recorded), the alert always reported the generic `TerminalFallbackAttemptFailure`
  instead of the concrete error class — making the alert least accurate exactly
  when fallback failed for a known reason. `AttemptOutcome` had to carry
  `errorClass` so the notification could use the real class.
- **Alert delayed behind the final await.** The breaker-open notification was
  deferred until _after_ the fallback attempt finished. With each attempt
  budgeting 180s under Convex's 600s action cap, two primary timeouts plus the
  fallback can run close enough to the cap that the action is killed before the
  notification fires — even though the breaker had already opened. The fix emits
  a minimal breaker-open alert (`Fallback: pending`) before awaiting fallback,
  then sends the fallback outcome separately.

**Why it matters.** Observability added for failures must survive the failures it
describes. An outcome type that overwrites the concrete error class loses the one
field operators need; an alert scheduled after a long await can be killed by the
action cap precisely on the slow/retried turns that most need surfacing.

**Preventive checks.**

- When an outcome flows through retry → fallback → aggregation, **thread the
  concrete error class (and other diagnostic context) through the outcome type**;
  don't collapse it to a generic sentinel at the last hop.
- **Emit critical alerts before long awaits**, not after. If a notification
  follows an operation that can approach `CONVEX_ACTION_MAX_MS`, send a minimal
  version first and append the result from a best-effort/`finally` path.
- Add a regression test asserting the alert is emitted **before** the final
  fallback attempt, and that the reported class matches the terminal error.

## 9. Model the nullable fields the upstream actually returns, and never let a "value unknown" refresh clobber stored data

**Seen in:** #429 (2 review threads — one Major, one P2)

**Problem.** PR #429 normalized Tonal sub-account profile data where Tonal can
return `null` for numeric fields. Two gaps:

- **Type didn't match the payload.** `TonalUser` declared `heightInches`,
  `weightPounds`, and `workoutsPerWeek` as non-nullable `number`, even though
  `toUserProfileData` already coerced `null → 0` (`?? 0`) and a test fed those
  fields as `null`. The interface had to become `number | null` to model the real
  payload shape.
- **Refresh overwrote good data with zeros.** Coercing `null → 0` is fine for
  first-time connect validation, but `updateProfileData` replaces the whole
  stored `profileData`, so on a refresh/backfill where Tonal merely reported a
  value as _unknown_, a user with real height/weight/frequency was downgraded to
  `0` — and those zeros then flowed into the AI context (`0"/0lbs`, `0x/week`).
  The mapper had to accept the existing stored measurements and fall back to `0`
  only when both the payload _and_ the stored profile lacked a value.

**Why it matters.** A type that's narrower than the upstream payload hides
nullable cases from the compiler, so callers (and tests) don't handle them. And a
whole-record overwrite that treats "unknown" as "zero" is silent, irreversible
data loss — degrading downstream AI/coaching outputs without any error.

**Preventive checks.**

- Match external-API type definitions to **what the payload can actually return**
  (cross-check against a real null sample and any normalizer using `?? default`);
  a field normalized with `?? 0` is a signal the source type should be nullable.
- For any refresh/backfill that **replaces a whole stored record**, distinguish
  "upstream says the value is unknown" from "upstream confirms the value is zero."
  Preserve prior non-null values when the new payload is null; only fall back to a
  default when no prior value exists.
- Add regression coverage asserting stored measurements **survive** a refresh
  whose payload returns null fields.

---

## How to use this log

- Before opening a PR that touches **Tonal fetch helpers, AI cost/budget paths,
  test fixtures, scheduled sweeps, React error boundaries around optional
  integrations, credential/format validators, outbound-payload filtering/
  serialization, retry/fallback failure reporting, or external-API type
  definitions and profile refresh/backfill**, skim the matching section above.
- When a review surfaces a _new_ recurring, legitimate gap (not stylistic, not
  one-off), add an entry here with the PR reference so the next agent inherits
  the lesson.
