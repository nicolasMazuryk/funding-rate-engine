# Execution & Account State — Orders, Positions, Funding Fee

**Document:** `11_execution_and_account_state.md` · includes `00_globals.md` by reference
**Covers:** order management (WS-first, REST fallback), the order FSM, idempotency, account setup (leverage/margin/position mode), precision & min-limit enforcement, sizing/denomination, private WS streams (orders, positions, balances, funding-fee), and position + funding-fee tracking.

**Conclusion first.** This is the **write + account-state** layer between intents (`12`) and the venue. Orders are placed and cancelled **over WebSocket**, falling back to REST only on WS failure (OKX being the sanctioned WS-order REST fallback, `00_globals.md` §6). Every order carries a `clientOrderId` for idempotency. Account plumbing — one-way position mode, isolated margin, leverage — is set **once in advance**, never mid-trade. Positions and funding are tracked from private WS events with REST as ground truth.

---

## 1. Account setup (in advance, fail-loud)

Before the first intent, per symbol that may trade:

| Setting | Value | When |
|---|---|---|
| Position mode | **one-way** (no hedge) | at startup / first use |
| Margin mode | **isolated** | at startup / first use |
| Leverage | `config.leverage` (per-exchange delta may apply, `00_globals.md` §6) | at startup / first use |

`setLeverage` failure is a **hard reject** (`00_globals.md` §4) — the strategy does not run on a symbol whose leverage/mode couldn't be set. Leverage posts margin only; it never scales notional or P&L (`00_globals.md` §4). These calls are idempotent on the venue; the adapter records the applied state to avoid redundant calls.

---

## 2. Order request & sizing

```
qty = amountUsd / price / contractSize          # 00_globals §4
qty = floor(qty, amountPrecision)               # lot step
price = round(price, pricePrecision)            # limit/stop prices
```

- **Denomination** handled in the adapter (`10` §4): internal math is base-unit; the venue multiple (e.g. `1000PEPE`) is applied only at the API boundary.
- **Fixed sizing** for now: `amountUsd = 20` (brief; `00_globals.md` §4). Ladders (S4.1a) split `amountUsd` across rungs by largest-remainder over the lot step (`00_globals.md` §G-R) — sub-min-notional rungs are dropped.

---

## 3. Precision & min-limit enforcement (binding)

Every order is checked against the instrument (`10` §4) **before submission**:

| Check | Rule | Fail action |
|---|---|---|
| Price tick | round to `pricePrecision` | round (never reject) |
| Lot step | floor to `amountPrecision` | floor; if result 0 → infeasible |
| Min notional (`minCost`) | `qty × price ≥ minNotional` | **skip symbol** (`00_globals.md` §G-R) |
| Min qty | `qty ≥ minQty` | skip symbol |
| Reduce-only sanity | exit qty ≤ tracked position qty | cap, engine-enforced |

A symbol failing min-notional at the **top/only** rung is skipped entirely (ladder rule, `00_globals.md` §G-R).

---

## 4. Idempotency (`clientOrderId`)

- Every order gets a deterministic `clientOrderId` = `f(intentId, leg, attempt)` — unique, reproducible, and safe to **retry** without double-submitting.
- On WS→REST fallback or reconnect, the engine **re-queries by `clientOrderId`** (`getOrder`) instead of blindly resubmitting; an already-accepted order is adopted, not duplicated.
- The WAL (`14`) records the `clientOrderId` **before** submission, so recovery can reconcile "did this order reach the venue?" deterministically.

---

## 5. Order path: WS-first, REST fallback

```
place / cancel:
  try WS order adapter (native lib)                       # 00_globals §6 hot path
  on WsTimeout / WS error:
    OKX      → REST fallback (sanctioned, §6)
    others   → bounded retry on WS; then abort the leg → OrderRejected/main_order_failed
  confirm via OrderUpdate event; if no event in window → REST getOrder poll
             (10 s timeout, ≤ 15 polls, circuit-open on consecutive errors — §6)
```

- **WS-mandatory strategies** (`strategy_1_ws`, `strategy_2`, `strategy_6`) require the WS order adapter and **throw at startup** without one; only OKX may fall back to REST for orders (`00_globals.md` §6).
- **Submission stagger** per venue (Bybit 150 ms, Binance 100 ms, others 100 ms default; `00_globals.md` §6) serializes multi-order placements (e.g. ladder rungs).
- **Rate-limit reserve** (`10` §6) guarantees the order lane against market-data starvation.

---

## 6. Order FSM

One shared FSM engine (`08` §5), driven by `OrderUpdate` events. Terminal order states feed the **intent** FSM (`12`).

```
        submit                 ack                    fill / partial→fill
NEW ──────────────▶ SUBMITTING ──────▶ OPEN ───────────────────────▶ FILLED
  │                     │                │  cancel                     
  │  submit error       │ reject         │──────────▶ CANCELLED         
  ▼                     ▼                │  expiry (limit)              
FAILED               REJECTED            └──────────▶ EXPIRED  → error_code=limit_expired
```

| State | Meaning | Exit edges |
|---|---|---|
| `NEW` | request built, `clientOrderId` WAL-written | → `SUBMITTING` |
| `SUBMITTING` | sent (WS/REST), awaiting ack | → `OPEN` / `REJECTED` / `FAILED` |
| `OPEN` | resting/live on venue | → `FILLED` / `CANCELLED` / `EXPIRED` |
| `FILLED` | fully filled (records `fillPx`, `qty`) | terminal → intent |
| `PARTIAL` | partial fill (ladders/large) | → `FILLED` / `CANCELLED` (keeps filled qty) |
| `CANCELLED` | cancelled (sweep, sibling OCO, deadline) | terminal |
| `EXPIRED` | limit reached `expireAt` unfilled | terminal → `limit_expired` / `ladder_no_fills` |
| `REJECTED` / `FAILED` | venue rejected / submit threw | terminal → intent error_code |

**Failure modes → error codes** map to `00_globals.md` §10.2 (`limit_expired`, `ladder_no_fills`, and the full S6 entry set `pre_funding_order_failed` … `close_pre_funding_failed`). OCO/sweep semantics: a sibling fill cancels the other leg; the post-exit sweep (`00_globals.md` §5.2) cancels lingering reduce-only orders.

---

## 7. Private WS streams

Native private streams push account-state events onto the bus (`08` §4). REST is the periodic ground-truth reconcile.

| Stream | Event | Consumers | Ground truth |
|---|---|---|---|
| Order / account updates | `OrderUpdate` | order FSM (§6), intent FSM (`12`) | REST `getOrder` (fill-poll, §5) |
| Funding-fee accrual | `FundingFeeAccrued { symbol, amount, fundingTime }` | S1-WS/S2/S6 funding gate, funding tracker (§9) | REST funding-fee poll (`T_settle+3 s`, 8 s grace, `00_globals.md` §6) + `fundingHistory` |
| Positions | `PositionUpdate { symbol, qty, side, entryPx }` | position tracker (§8), risk (`13`) | REST `getPositions` |
| Balances | `BalanceUpdate { asset, free, used }` | preflight (`12`), risk (`13`) | REST `getBalance` |

- **Funding-fee event matching:** `fundingTime` must be within **±30 s** of the expected `T_settle` to match an intent (`00_globals.md` §6); a mismatched event inside tolerance is the known tight-tolerance failure mode (`02_strategy_1_ws.md` §3).
- **Reconnect/gap:** on reconnect, a REST snapshot re-primes positions/balances/open-orders before resuming stream consumption — no silent state drift.

---

## 8. Position tracking

- Authoritative in-memory position per symbol, updated from `PositionUpdate` and reconciled against REST `getPositions` at key moments: after entry fill, after exit, and on a periodic tick.
- **REST getPositions is normative ground truth** at the post-MAIN-fill confirmation for S6 (`07_strategy_6.md` §2, now spec) and for exit sizing; on REST failure the engine falls back to tracked fills with a warning (as S6 §2 specifies).
- Net position for reversal strategies (S6): `mainVolume − preFundingVolume` (`07_strategy_6.md`). Reduce-only exits are capped to tracked qty (§3).
- **Orphan detection:** a venue position with no owning intent (crash/desync) triggers orphan auto-flatten (`00_globals.md` §5.3, wired in `13`).

---

## 9. Funding-fee tracking

- **Real-time accrual:** the `FundingFeeAccrued` event is the live signal that funding actually credited/charged — it opens the funding gate for WS-gated strategies (S1-WS/S2/S6) and stamps the intent's funding leg.
- **History:** `fundingHistory` (REST) backfills settled amounts for reconciliation and analytics (`15`).

---

## 10. Boundaries

This layer owns venue-facing writes and account state; it does **not** decide *when* to trade (that is the strategy runtime, `12`) or *whether* it's safe to trade (risk, `13`). It emits order/position/funding facts as events and executes intent commands. Everything here is persisted through the WAL before the side effect (`14`) so execution is crash-recoverable and idempotent.
