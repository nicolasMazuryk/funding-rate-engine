# Persistence & Recovery

**Document:** `14_persistence_and_recovery.md` · includes `00_globals.md` by reference
**Covers:** the write-ahead log (WAL), the Postgres/Drizzle schema (overview), idempotency at the store, and crash recovery.

**Conclusion first.** Every state transition is **WAL-persisted before its side effect**, so a crashed instance resumes deterministically: it can always answer "did this order reach the venue?" and "what state was this intent in?". Postgres (via Drizzle) is a single **centralized store shared by the whole fleet**, every row tagged with the owning instance (`exchange`, `strategy`, `subaccount`); the WAL is an append-only intent-event log that is the source of truth for recovery, reconciled against venue REST ground truth on startup. KISS: one fleet-wide database, typed schema, no external queue or event store.

**Hot-path rule (binding).** "WAL-persisted before its side effect" is a *local, on-box* durability guarantee, not a network round-trip to Postgres.

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

- **Append-only** log of intent lifecycle events: `{ ts, intentId, fromState, toState, payload, clientOrderId? }`.
- **Ordering rule (binding):** a WAL entry for a transition is durably committed **before** the side effect it authorizes (order submit, cancel, flatten). On restart, the last WAL entry tells the engine exactly where it was and whether the side effect may have occurred.
- The WAL is the **recovery source of truth**; derived tables (positions, trades, P&L) are projections rebuilt or reconciled from it plus venue ground truth (`15`).
- Cheap by design: one strategy, one exchange, low intent rate (a handful per hour) → the WAL is small and fast; no partitioning or retention engineering needed (KISS).

### 2.1 Two-tier write path — KISS, non-blocking (binding)

Persistence is a **centralized** Postgres shared by the whole fleet (§0, `16`), so a synchronous WAL write is a network round-trip, not a local disk write — exactly the kind of blocking I/O that must never sit on the hot path (`08` §6). One small mechanism keeps it off, no queue or broker needed:

```
commit(transition):
  1. append transition to a local, on-box, append-only WAL file (fsync'd)   # sub-millisecond, no network — THIS gates the side effect
  2. return immediately → caller proceeds to the side effect (order submit/cancel/flatten)
  3. (async, off the hot path) background forwarder batches unshipped local entries
     and upserts them into the centralized Postgres `intent_wal` table on a short interval
     (e.g. every 200 ms or N entries) — idempotent by (intentId, fromState, toState)
```

- **The local append is the ordering commit point**, not the Postgres write. Step 1 is what the binding ordering rule (§2) refers to — it is what "before its side effect" means operationally.
- The forwarder never blocks the caller: on forwarder lag or a centralized-Postgres outage, the local file keeps growing (bounded by disk) and catches up once Postgres is reachable again. The hot path is unaffected either way.
- On restart, recovery (§5) replays the local file first — entries not yet forwarded are simply re-sent; nothing is lost, nothing double-counts (idempotent upsert).
- This is the **only** mechanism needed: one local file, one background forwarder. No message broker, no external queue (KISS holds).

---

## 3. Postgres schema (overview, Drizzle)

Typed schema, migrations under version control. **Single centralized database for the whole fleet** (`16`) — every table below carries an `instance_id` (`exchange`, `strategy`, `subaccount`) column, and every query is scoped by it, keeping instances logically isolated inside the shared DB:

| Table | Purpose |
|---|---|
| `intents` | one row per intent: `instance_id`, strategy, symbol, `T_settle`, current state, `exit_reason`/`error_code`, config hash |
| `intent_wal` | append-only transition log, forwarded from the local per-instance WAL file (§2.1) |
| `orders` | one row per order leg: `instance_id`, `clientOrderId`, venue id, type, side, price, qty, status, fills |
| `fills` | individual fills with price, qty, fee class, ts |
| `positions` | tracked position snapshots (reconciled vs REST) |
| `funding_events` | `FundingFeeAccrued` records + settled amounts (`11` §9) |
| `pnl` | per-intent decomposition: `delta_pnl`, `funding_pnl`, `fee_cost`, `net_pnl` (`00_globals.md` §8.3) |
| `kill_switch` | current operational state (`13`), one row per `instance_id` |
| `reconciliation` | system↔exchange diffs and resolutions (`15`) |

Output variables per trade follow the canonical registry in `00_globals.md` §8.3, so every trade row is comparable across strategies, exchanges, and instances, and directly joinable/aggregatable in SQL within the single database (`15` §5).

---

## 4. Idempotency at the store

- Writes keyed by natural idempotency keys: `intentId`, `clientOrderId`, `(symbol, fundingTime)` for funding events. Re-processing the same venue event (duplicate WS message, reconnect replay) is a no-op upsert, never a double count.
- The `clientOrderId`-before-submit rule (`11` §4) plus the WAL ordering rule (§2) together make order submission **exactly-once in effect**: at most one live order per leg, and recovery adopts an already-placed order rather than resubmitting.

---

## 5. Crash recovery (startup sequence)

```
on boot:
  1. load EffectiveConfig (09) + verify config hash matches persisted in-flight intents
  2. replay WAL, scoped to this instance_id:
       - local on-box WAL file first (source of truth for anything not yet forwarded, §2.1)
       - then centralized Postgres intent_wal for already-shipped history
     → reconstruct in-memory FSM state of any non-terminal intent
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

- Local WAL files (§2.1): durable via `fsync` on every append, one file per instance, no separate backup process — a short-lived staging buffer ahead of the centralized DB, not the archival record.
- Centralized Postgres: standard durability (`synchronous_commit` on for `intent_wal` writes), scoped per instance by `instance_id`. Recovery for any one instance scopes to its own `instance_id` rows — a tiny replay scope regardless of fleet size.
- Periodic logical backups for analytics/audit history; the live recovery path depends on the local WAL file + centralized DB + venue REST, not on backups.

---

## 7. Scope

This layer implements the `Repo` port the core depends on (`08` §5). The core never touches Drizzle or `pg` directly — it reads/writes through repository interfaces, which keeps the runtime pure and lets tests substitute an in-memory repo (`17`).
