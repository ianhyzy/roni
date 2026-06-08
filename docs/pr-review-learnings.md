# PR Review Learnings

Last reviewed: 2026-06-08

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

## 7. When filtering a payload before an external push, guard the empty case, re-derive every dependent count, and preserve structural markers

**Seen in:** #440 (3 review threads — one P2, two P3, all addressed in one follow-up)

**Problem.** `buildTonalWorkoutSets` began stripping synthetic movements (e.g.
rest sentinels) out of the set list before POSTing to Tonal. Filtering a
collection just before it leaves the system created three distinct gaps:

- **Empty payload reached the wire.** The helper can legitimately return `[]`
  (a rest-only block filters down to nothing), but the push path still
  constructed `{ title, sets: [], ... }` and POSTed it. Tonal answers an empty
  set list with a misleading 400, so `createWorkout` recorded a _failed plan_
  after a remote round-trip instead of failing fast with a clear local error.
  The estimate path already guarded this; the push path didn't.
- **A dependent count was computed from the unfiltered source.** `createWorkout`
  still derived `setCount` from a _separate_ `expandBlocksToSets(blocks)` call,
  so the user/LLM-visible success result counted the rest sentinels that were
  never pushed (3 work sets + 3 rest sentinels reported 6, only 3 posted).
- **Filtering stripped a structural marker.** `expandBlocksToSets` marks the
  first set of each block `blockStart: true`. If a block led with a synthetic
  movement, filtering removed exactly that set, so the first _real_ set shipped
  with `blockStart: false` — a payload whose block boundaries no longer matched
  the internally validated block structure.

**Why it matters.** A filter step looks local, but everything _downstream_ of it
— the empty-case contract, any count/metadata computed in parallel from the
unfiltered input, and structural invariants the removed elements carried — can
silently drift out of sync with what actually gets sent. The failures surface as
opaque remote 4xx, overstated success metrics, or structurally invalid payloads
that already passed validation.

**Preventive checks.**

- After a filter that can empty a collection bound for an external API, **guard
  `length === 0` before constructing/sending the payload** and fail with a clear
  local error (matching the function's existing `{ error } | { ok }` contract),
  rather than letting the remote service reject it.
- **Derive every reported count/metadata from the same filtered list** that
  forms the payload — never from a parallel unfiltered computation of the same
  source.
- After removing elements, **re-establish positional/structural invariants** the
  removed elements may have carried (here, re-mark the first remaining set per
  block as `blockStart`), or reject inputs that place a removable element in a
  structural position.
- Check the sibling path (estimate vs. push, dry-run vs. commit): if one already
  guards a case, the other almost certainly needs the same guard.

## 8. Don't let "missing → default" normalization clobber previously-stored real values on refresh/backfill

**Seen in:** #429 (P2, plus a typing thread; both addressed)

**Problem.** Tonal sub-accounts return `null` for `heightInches`,
`weightPounds`, and `workoutsPerWeek`. `toUserProfileData` normalized those nulls
to `0` (`?? 0`) so first-time-connect validation had concrete numbers. But
`userProfiles.updateProfileData` **replaces the whole stored `profileData`**, and
the same mapper ran on refresh/backfill paths (`forceRefreshUserData`,
`maybeRefreshProfile`, `profileBackfill`). So a user who already had a real
height/weight/frequency got **downgraded to `0`** whenever a later payload merely
said "unknown" — and those zeros then flowed into the AI context as `0"/0lbs`,
`0x/week`. Separately, the `TonalUser` interface still typed these fields as
non-nullable `number` while the real payload (and the test fixture) sent `null`.

**Why it matters.** A default-fill that is _correct_ for an initial write becomes
_destructive_ on an update: "the latest payload doesn't know this value" is not
the same as "this value is now zero." Clobbering silently degrades data the
system already had, and the degraded values propagate into downstream consumers
(AI context, stats) where they look like real measurements.

**Preventive checks.**

- A normalization that injects a default for a missing field must, on
  **update/refresh/backfill** paths, **fall back to the previously-stored value
  first**, and only to the hard default when both the new payload _and_ the prior
  record are missing it (`tonalValue ?? existingValue ?? 0`). Thread the existing
  record into the mapper at every refresh call site.
- Distinguish **first-write** (no prior value to protect) from **update** (prior
  value must not be silently overwritten by a "missing"); a mapper used by both
  needs the existing record as an input.
- **Type the field as it really arrives.** If the upstream payload can send
  `null`, model it as `number | null` (don't assume non-null because the happy
  path usually has a value) — and cover the nullable case in a fixture/test.
- Add a regression test that seeds a real prior value, refreshes with a `null`
  payload, and asserts the stored value is **preserved**, not zeroed.

## 9. On the AI action-cap budget, emit critical notifications before long awaits and carry the concrete terminal error class through fallback

**Seen in:** #434 (2 P2 threads; both addressed)

**Problem.** The circuit-breaker alerting was reworked to add fallback context.
Two gaps appeared, both rooted in the same 600s Convex action cap that drives
learning #4:

- **Notification deferred behind a long await.** The breaker-open alert was sent
  only _after_ the final fallback attempt finished. With `convex/ai/resilience.ts`
  budgeting 180s per attempt, two primary timeouts plus the fallback can run
  close to the 600s cap, so the action could be killed _before_ the notification
  fired — even though the breaker had already opened. An alert you only send
  after the risky work completes is exactly the alert the action cap can eat.
- **Terminal error class flattened.** When the fallback ended via `runAttempt`
  returning `{ done: true, success: false }` (the BYOK/quota/other non-transient
  path), the alert always reported a generic `TerminalFallbackAttemptFailure`,
  discarding the concrete class `streamWithRetry` had already determined — so the
  alert was least informative precisely when fallback failed for a known reason.

**Why it matters.** This is the action-cap discipline of learning #4 applied to
_ordering and signal fidelity_, not just timer math. A self-reporting mechanism
that does its reporting after the part most likely to be killed loses the report
on exactly the slow/retried turns it exists to flag; and collapsing a known error
class into a generic sentinel strips the operator's ability to tell a billing
failure from a quota failure from a transient one (the same "don't swallow the
signal" thread as learnings #1 and #3).

**Preventive checks.**

- Emit the **critical/state-change notification before awaiting** any long
  operation that could approach the action cap (here: send breaker-open with
  `Fallback: pending` _before_ starting the final fallback, then send the
  outcome separately or from a best-effort `finally`). Don't gate a
  must-deliver alert on work that may not complete.
- **Carry the concrete terminal error class** end to end (thread `errorClass`
  through `AttemptOutcome`) and use it for both primary and fallback terminal
  alerts; never replace a known class with a generic fallback sentinel.
- When reordering work around the action cap, add a regression test asserting
  the **ordering invariant** (notification happens before the final fallback
  await), the same way learning #4 pins the timer invariant.

---

## How to use this log

- Before opening a PR that touches **Tonal fetch helpers, AI cost/budget paths,
  test fixtures, scheduled sweeps, React error boundaries around optional
  integrations, credential/format validators, payloads filtered before an
  external push, profile/data normalization on refresh/backfill, or AI
  fallback/notification ordering under the action cap**, skim the matching
  section above.
- When a review surfaces a _new_ recurring, legitimate gap (not stylistic, not
  one-off), add an entry here with the PR reference so the next agent inherits
  the lesson.
