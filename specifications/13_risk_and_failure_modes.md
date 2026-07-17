# Risk Management & Failure Modes

**Document:** `13_risk_and_failure_modes.md` · includes `00_globals.md` by reference (safety mechanisms §7)
**Covers:** the risk gate, kill switch, circuit breakers, flatten, and a consolidated failure-mode catalog.

**Conclusion first.** Risk is a **single gate** in preflight (`12` §3) plus a small set of always-on guards that can pause or flatten the instance. The kill switch and orphan/sweep mechanics are already defined in `00_globals.md` §7 — this doc makes them operational for the live engine and adds circuit breakers and the failure catalog. Because each instance is one strategy on one exchange on one sub-account (`16`), blast radius is bounded by construction: the worst case is one flat sub-account.

---

## 1. Risk gate (preflight, per intent)

Evaluated in preflight (`12` §3) before any venue write. All limits are per-instance and come from `config.risk` (`09` §3).

| Limit | Default (fixed-sizing era) | Effect on breach |
|---|---|---|
| `max_concurrent_intents` | 1 | reject new intent while one is live |
| `max_notional_usd` | `amount_usd` (20) | reject oversize/duplicate |
| `max_daily_loss_usd` | configured | pause instance (kill switch → `paused`) |
| `breaker_error_threshold` | 5 consecutive venue errors | open circuit (§3) |

The gate is pure and data-driven — no per-strategy special cases (DRY). With fixed $20 sizing and one concurrent intent, notional risk per instance is trivially bounded; the limits exist to catch **desync and runaway** conditions, not to size positions.

---

## 2. Kill switch

States and semantics are normative in `00_globals.md` §7.1:

| State | Behavior |
|---|---|
| `off` | normal operation |
| `paused` | `preflight()` rejects **every** new intent with `error_code = kill_switch` before any exchange call; existing positions continue to be managed to their exit |
| `flatten` | as `paused`, **plus** `flattenAll()` — reduce-only market closes across the instance's positions (`exit_reason = kill_switch_flatten`, `00_globals.md` §12.1) |

- Bootstrapped from `.env` `KILL_SWITCH` (`09` §2); runtime transitions are operational and **persisted** (`14`) so a restart honors the last state.
- Engine-internal: `paused` produces **no** exchange-side activity; only `flatten` touches the venue.
- Triggers: manual (ops), or automatic on a tripped daily-loss limit or an open circuit that stays open (§3).

---

## 3. Circuit breakers

Per-instance, per-concern breakers (adapter I/O, order path). Standard closed→open→half-open cycle:

| Concern | Opens on | While open | Half-open probe |
|---|---|---|---|
| Venue REST/WS I/O | ≥ `breaker_error_threshold` consecutive `NetworkError`/`VenueUnavailable` (`10` §5) | new intents rejected (risk gate); market-data reconnect continues | single test call; success → close, failure → stay open |
| Order submission | repeated `OrderRejected`/`FAILED` on the order lane | escalate to `paused` if it recurs during a live intent | manual/ops review |

An order-path breaker that opens **during** a live position does **not** abandon the position — exit management and the abort/flatten ladders (per strategy, e.g. S6 `07_strategy_6.md` §2) still run to protect it; only **new** entries are blocked. A breaker that stays open past a bound escalates the kill switch to `paused`/`flatten`.

---

## 4. Flatten

`flattenAll()` (kill-switch `flatten`, `00_globals.md` §7.1): reduce-only market close of every tracked position on the instance, retried with backoff, using **REST `getPositions` as ground truth** for what actually needs closing (mirrors the S6 abort ladder, `07_strategy_6.md` §2). A position that cannot be flattened after retries is an **orphan** → alert + orphan auto-flatten backstop (§5).

---

## 5. Orphan & desync handling

From `00_globals.md` §7.2/§7.3, made operational:

- **Post-exit sweep** (`sweepReduceOnlyOrders`, §7.2): after every exit, cancel lingering reduce-only orders for the symbol. Expected, not pathological, for `sl_tp_deadline`-family strategies.
- **Orphan auto-flatten** (§7.3): a venue position with no owning intent (crash/desync, detected via `PositionUpdate` vs intent store, `11` §8) is auto-flattened; a stale reduce-only sweep runs before entry.
- **Ground truth on reconnect:** private-stream reconnect re-primes state from REST before resuming (`11` §7), preventing acting on stale account state.

---

## 6. Failure-mode catalog (consolidated)

| Failure | Detection | Response | Terminal mapping |
|---|---|---|---|
| Kill switch engaged | preflight | reject/flatten | `kill_switch` / `kill_switch_flatten` |
| Insufficient balance | preflight / venue | reject intent | `error_code` (no position) |
| Precision / min-notional | preflight (`11` §3) | skip symbol | (no intent) |
| Entry order reject/fail | order FSM (`11` §6) | terminate | `main_order_*`, submit codes (`00_globals.md` §12.2) |
| Limit never fills | order FSM expiry | cancel, no position | `limit_expired` / `ladder_no_fills` |
| WS funding event miss (S1-WS/S2/S6) | timeout (`11` §7) | timeout fallback / abort | `funding_fee_timeout` (S1-WS) / `funding_event_timeout` (S6) |
| PRE_FUNDING not filled (S6) | WS event vs fill (`07_strategy_6.md`) | abort + close | `pre_funding_not_filled` |
| Can't flatten PRE_FUNDING (S6) | abort ladder exhausted | ops alert + orphan backstop | `close_pre_funding_failed` |
| Venue unavailable / network | circuit breaker (§3) | pause new intents; protect open ones | — |
| Rate-limit exhaustion | rate limiter (`10` §6) | queue non-critical; raise on order lane | `RateLimited` |
| Crash mid-intent | WAL replay (`14`) | deterministic recovery | resume/close |
| Orphan position | position reconcile (§5) | auto-flatten + alert | — |

Every failure has exactly one terminal mapping (no ambiguous states — the reason `00_globals.md` §12 exists). The runtime never silently swallows a failure: it either recovers deterministically or terminates the intent with a code.

---

## 7. Design stance

Risk logic is **centralized** (one gate, one kill switch, one breaker utility) and **data-driven** (limits in config). No strategy embeds its own bespoke risk checks beyond the exit policies already specified in `01`–`07`. This keeps risk auditable in one place and uniform across the fleet, and keeps the strategy modules pure.
