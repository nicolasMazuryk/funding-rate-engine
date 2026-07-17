# Persistence & Recovery

**Document:** `14_persistence_and_recovery.md` · includes `00_globals.md` by reference
**Covers:** the write-ahead log (WAL), the Postgres/Drizzle schema (overview), idempotency at the store, and crash recovery.

**Conclusion first.** Every state transition is **WAL-persisted before its side effect**, so a crashed instance resumes deterministically: it can always answer "did this order reach the venue?" and "what state was this intent in?". Postgres (via Drizzle) is the single store per instance; the WAL is an append-only intent-event log that is the source of truth for recovery, reconciled against venue REST ground truth on startup. KISS: one database per instance, typed schema, no external queue or event store.

---

## 1. What must survive a crash

| State | Why it must persist | Recovery use |
|---|---|---|
| Intent + FSM state (`12` §5) | know what was in flight | resume/close on restart |
| `clientOrderId` per order leg (`11` §4) | answer "did this submit reach the venue?" | REST reconcile, no double-submit |
| Fills, positions, funding accrual (`11` §8–§9) | account truth | reconcile vs venue |
| S2 retracement tracker state (`03_strategy_2.md`) | trailing TP must survive restart | **re-spawn tracker from DB** (§5) |
| Kill-switch state (`13`) | honor last operational state | restore on boot |
| Config revision hash (`09` §7) | trade attributable to exact config | audit/analytics |

---

## 2. WAL (write-ahead log)

- **Append-only** table of intent lifecycle events: `{ ts, intentId, fromState, toState, payload, clientOrderId? }`.
- **Ordering rule (binding):** the WAL entry for a transition is committed **before** the side effect it authorizes (order submit, cancel, flatten). On restart, the last WAL entry tells the engine exactly where it was and whether the side effect may have occurred.
- The WAL is the **recovery source of truth**; derived tables (positions, trades, P&L) are projections rebuilt or reconciled from it plus venue ground truth (`15`).
- Cheap by design: one strategy, one exchange, low intent rate (a handful per hour) → the WAL is small and fast; no partitioning or retention engineering needed (KISS).

---

## 3. Postgres schema (overview, Drizzle)

Typed schema, migrations under version control. Indicative tables (one DB per instance, `16`):

| Table | Purpose |
|---|---|
| `intents` | one row per intent: strategy, symbol, `T_settle`, current state, `exit_reason`/`error_code`, config hash |
| `intent_wal` | append-only transition log (§2) |
| `orders` | one row per order leg: `clientOrderId`, venue id, type, side, price, qty, status, fills |
| `fills` | individual fills with price, qty, fee class, ts |
| `positions` | tracked position snapshots (reconciled vs REST) |
| `funding_events` | `FundingFeeAccrued` records + settled amounts (`11` §9) |
| `pnl` | per-intent decomposition: `delta_pnl`, `funding_pnl`, `fee_cost`, `net_pnl` (`00_globals.md` §8.3) |
| `kill_switch` | current operational state (`13`) |
| `reconciliation` | system↔exchange diffs and resolutions (`15`) |

Output variables per trade follow the canonical registry in `00_globals.md` §8.3, so every trade row is comparable across strategies, exchanges, and instances.

---

## 4. Idempotency at the store

- Writes keyed by natural idempotency keys: `intentId`, `clientOrderId`, `(symbol, fundingTime)` for funding events. Re-processing the same venue event (duplicate WS message, reconnect replay) is a no-op upsert, never a double count.
- The `clientOrderId`-before-submit rule (`11` §4) plus the WAL ordering rule (§2) together make order submission **exactly-once in effect**: at most one live order per leg, and recovery adopts an already-placed order rather than resubmitting.

---

## 5. Crash recovery (startup sequence)

```
on boot:
  1. load EffectiveConfig (09) + verify config hash matches persisted in-flight intents
  2. replay intent_wal → reconstruct in-memory FSM state of any non-terminal intent
  3. reconcile vs venue REST ground truth (11 §7/§8):
       - open orders    (getOrder by clientOrderId)
       - positions      (getPositions)
       - balances       (getBalance)
       - funding history (fundingHistory)
  4. resolve each in-flight intent:
       - order placed & filled but WAL didn't record it   → adopt, advance FSM
       - order in WAL but not on venue                     → re-submit (idempotent) or abort
       - venue position with no intent                     → orphan auto-flatten (13 §5)
       - S2 tracker state present                          → re-spawn retracement tracker (03_strategy_2 §2)
  5. restore kill-switch state; then resume normal scheduling (12)
```

Recovery is **deterministic**: the WAL + venue ground truth fully determine the correct next action for every in-flight intent. There is no guesswork and no double-execution.

---

## 6. Backup & durability

- Postgres with standard durability (`synchronous_commit` on for the WAL-critical writes). One DB per instance keeps recovery scope tiny and isolates failure (a corrupted DB affects one sub-account, `16`).
- Periodic logical backups for analytics/audit history; the live recovery path depends only on the current DB + venue REST, not on backups.

---

## 7. Scope

This layer implements the `Repo` port the core depends on (`08` §5). The core never touches Drizzle or `pg` directly — it reads/writes through repository interfaces, which keeps the runtime pure and lets tests substitute an in-memory repo (`17`).
