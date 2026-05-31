# Engineering Learning Log

A running record of non-obvious mistakes caught in PR review, distilled into
preventive checks so they don't recur. Each entry: the gap, why it matters, and
the check that would have caught it. Add to this when a review surfaces a real
logic/completeness/edge-case issue (not style nits). Promote the most reusable
checks into `AGENTS.md` so they become part of the standing ruleset.

## How to use this log

- **Before writing similar code**, skim the relevant entries below.
- **After a PR review flags a real issue**, add an entry here in the same shape.
- Keep entries concrete: name the PR, the failure mode, and the verifiable check.

---

## 2026-05 — Scheduled cleanup timers must outlast the latest possible row creation

- **Source:** PR #412 (`fix(chat): finalize orphaned messages so chat can't hang on "generating"`), review thread on `convex/ai/stuckMessageWatchdog.ts`.
- **The gap:** A one-shot "watchdog" sweep was scheduled at the *start* of a coach
  turn, before provider resolution, prompt/context building, and `streamWithRetry`.
  The retry path budgets up to 3 × 180s attempts, so the assistant row for the
  *final* attempt can be created late in the action's life — long after the timer
  was queued. A single sweep that fires too early relative to that late row's
  creation + grace window sees the row as "too new", skips it, and queues no
  follow-up sweep. The orphaned message (and its perpetual "generating" spinner)
  is then stranded indefinitely.
- **Why it matters:** A self-healing recovery mechanism silently fails to heal
  exactly the slowest, most-degraded turns it exists to protect — the worst case,
  with no later retry. It looks correct in tests that use fast/happy-path turns.
- **Preventive check:** When scheduling a one-shot cleanup timer for rows that a
  long-running action may create *late*, derive the delay from
  `action-cap + retry-budget + grace`, not from turn start. Concretely, either:
  - delay ≥ `grace + max-late-creation-window` (the path taken here:
    `WATCHDOG_DELAY = grace + CONVEX_ACTION_MAX_MS + buffer`), **or**
  - reschedule the sweep when it still sees a non-terminal row newer than `grace`.
  Lock the invariant with a test, e.g. assert
  `WATCHDOG_DELAY_MS - GRACE_MS > CONVEX_ACTION_MAX_MS`, so a future constant tweak
  can't silently regress it. Prefer a larger fixed delay over self-rescheduling to
  keep the sweep stateless.

## 2026-05 — Test fixtures must not derive values from `Date.now()` / system time

- **Source:** PR #392 (`fix(tonal): replace fragile string check with instanceof …`), review thread on `convex/tonal/cachedFetch.test.ts`.
- **The gap:** Cache-entry fixtures computed `expiresAt` from `Date.now()`
  (`Date.now() - 1000` for stale, `Date.now() + 60_000` for fresh), making the
  tests time-dependent and theoretically flaky near boundaries.
- **Why it matters:** Reinforces the standing rule "Tests must be deterministic.
  No reliance on system time, random values, or network." Time-derived fixtures
  are the most common way this rule slips through, because they *look* like
  ordinary constants.
- **Preventive check:** For stale/fresh (or before/after) fixtures, use fixed
  sentinel constants instead of clock arithmetic — e.g.
  `const STALE_EXPIRES_AT = 0;` and `const FRESH_EXPIRES_AT = Number.MAX_SAFE_INTEGER;`.
  Already covered by **Testing Rules** in `AGENTS.md`; this entry is the worked
  example to point to.
