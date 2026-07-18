# 0380 — Circuit breakers, flatten, orphan handling, kill-switch operations

**Phase:** 5 — Sidecars full
**Depends on:** 0140, 0240, 0360
**Spec references:** `13_risk_and_failure_modes.md` §2 (kill switch operational), §3 (circuit breakers), §4 (flatten), §5 (orphan & desync); `00_globals.md` §5.1–§5.3

## Objective
Risk made operational: per-concern circuit breakers (venue I/O, order path) with the closed→open→half-open cycle feeding the risk gate; `flattenAll()` (reduce-only market close of every tracked position, retries with backoff, REST `getPositions` as ground truth) wired to kill-switch `flatten` with `exit_reason = kill_switch_flatten`; breaker escalation to `paused`/`flatten`; orphan auto-flatten and the stale reduce-only sweep before entry; kill-switch state persisted so restarts honor it.

## Context for the agent
Breaker semantics (`13` §3): venue-I/O breaker opens on ≥ `breaker_error_threshold` consecutive `NetworkError`/`VenueUnavailable` (0200 exposed the counting observer); while open, new intents are rejected via the risk gate but market-data reconnect continues; half-open sends one probe. Order-path breaker: repeated `OrderRejected`/`FAILED` → escalate to `paused` if recurring during a live intent. **A breaker opening during a live position never abandons the position** — exit management and abort ladders keep running; only new entries are blocked. A breaker open past a bound escalates the kill switch. `flattenAll` reuses S6's `closeWithRetries` utility (0350). Orphan auto-flatten: the events 0240 emits now get their handler. Kill-switch runtime transitions persist to the `kill_switch` table (0360) and restore on boot (0370's sequence gains the step if not present).

## Scope
- In scope:
  - `src/risk/breaker.ts` (generic utility, two instances) + wiring into adapter error observers and the risk gate; half-open probe scheduling via the clock.
  - `src/risk/flatten.ts`: `flattenAll()` per `13` §4; kill-switch `flatten` trigger; unresolvable position after retries → orphan alert path.
  - Orphan auto-flatten handler + stale reduce-only sweep before entry (`00_globals` §5.3), wired into the entry path.
  - Kill-switch persistence (write-through to `kill_switch` table) + restore on boot; escalation rules (breaker-open-past-bound → `paused`, recurring → `flatten` per `13` §3 policy — encode the bound in config `risk` section).
  - Scenario tests: consecutive `VenueUnavailable` → breaker opens → intent rejected while an open position's exit still executes; half-open probe closes on success; escalation transitions the kill switch and persists it; `flatten` closes multiple sim positions with `kill_switch_flatten`; orphan position auto-flattened; stale reduce-only order swept before a new entry.
- Out of scope: fleet-wide pause-all tooling (0520), live-tier flatten drills (0470).

## Implementation notes
The "protect open positions while blocking new entries" distinction is the subtle requirement — model breaker consultation only in preflight/new-intent paths, never in exit/abort paths; write a test that would catch a naive global gate. Escalation policy knobs (`open past bound`) aren't numerically specified — pick conservative defaults in the risk config schema, document in the config comment, and record the choice in STATUS.md notes.

## Verification (definition of done)
1. `npm run verify` + `npm run test:e2e` — green with all listed scenarios.
2. The protect-open-positions test: breaker open mid-MONITORING → exit order still submits and fills; a new scan candidate is rejected in the same window.
3. Kill-switch persistence: set `paused` at runtime, crash + recover (0370 harness) → still `paused`, preflight rejects.
4. `flatten` e2e: two open sim positions → both closed reduce-only, intents `CLOSED (kill_switch_flatten)`, account flat.
