# Strategy 1 — Negative Funding LONG, Timed Exit

**Document:** `01_strategy_1.md` · includes `00_globals.md` by reference · group common logic: `00_globals.md` §G-L
**Exit policy kind:** `timed`

**Conclusion first.** S1 bets that the funding payment received by a long held through settlement exceeds the price drop suffered in the seconds around it, plus two taker fees. This is the simplest strategy in the fleet. Timing risk concentrates entirely in the exit: a fixed `T_settle + exitOffsetSeconds` exit lands *before* the drop on some events (favorable) and *after or inside* it on others (unfavorable); that variance **is** the strategy and must not be optimized away by re-keying the exit to `T_drop` (see §6). Economics warning: with the empirical drop being a multiple of `|F|` (§2 of globals), S1 is structurally negative at weak thresholds — the profit condition arithmetic in §4 must clear at the configured threshold or the strategy should not run.

---

## 1. Selection logic

Per `00_globals.md` §G-L, no deltas:

```
AT decision_time = T_settle − entryOffsetSeconds:
  IF F_predicted ≤ negativeFundingThresholdPercent        # signed percent, e.g. −0.55 ≤ −0.4 → trigger
  AND market.status == 'trading'
  AND scheduler guards pass (00_globals.md §7: 0.1 pp pre-filter, snapshot ≤ 60 s old, most-negative-first)
  THEN trigger intent
```

## 2. Execution flow

| # | Time (rel.) | Action | Order | Price formula | Expiry/cancel |
|---|---|---|---|---|---|
| 1 | `T_settle − entryOffsetSeconds` | decide entry | — | — | — |
| 2 | decision + latency | ENTRY fill | BUY MARKET | best ask | n/a (market) |
| 3 | `T_settle + exitOffsetSeconds` | decide exit | — | — | — |
| 4 | decision + latency | EXIT fill | SELL MARKET **reduce-only** | best bid | n/a |
| 5 | post-exit | `sweepReduceOnlyOrders` (`00_globals.md` §5.2) | cancels | — | — |

No orders rest between entry and exit; there is nothing to cancel on the happy path. WS order adapter not mandatory for S1 (REST path acceptable). No events are awaited — S1 never subscribes to the funding-fee stream.

## 3. Exit policy

- **Kind:** `timed`. Exactly one exit path.
- **Path:** SELL MARKET reduce-only at `T_settle + exitOffsetSeconds`; fee class **taker**; `exit_reason = timed` — always, on every S1 trade.
- No SL, no TP, no deadline. S1 is the only strategy with a purely timed exit. Consequence: S1 has unbounded intra-window delta exposure between fill and `T_settle + exitOffsetSeconds + latency`; the exposure window is ≈ `entryOffsetSeconds + exitOffsetSeconds + 2 × latency` seconds (proposed: ≈ 11 s). Accepting that unhedged window is the design.

## 4. P&L decomposition & profit condition

Position is open at `T_settle` (entry fill ≈ `T_settle − 2 s` under proposed values) → receives funding, subject to the fill-time accrual test (`00_globals.md` §3.1).

```
DELTA_PNL   = (P_exit − P_entry) / P_entry × 100        # percent; typically negative (the drop)
FUNDING_PNL = +|F|                                       # iff fill_time < T_settle, else 0
FEES        = takerFeePct × 2
NET_PNL     = DELTA_PNL + FUNDING_PNL − FEES
```

**Profit condition:** `|F| > |DELTA_PNL| + 2 × takerFeePct`.

**Arithmetic at the proposed values** (taker 0.05% → fees 0.10%): at threshold −0.4, break-even drop tolerance is 0.30%. The empirical drop is typically ≥ 2× `|F|` (§2 of globals: −0.33% funding → ≈0.8% drop), so **a fixed exit that lands after the drop loses on the typical event**. S1's positive expectation therefore rests on the exit frequently landing *before* `T_drop` (drop lag 0–10 s vs exit at +6 s ⇒ roughly the later half of the lag distribution) and on partial-retrace paths. This must be validated against live trade data, broken down by `t_drop_offset_s` bucket. At threshold −0.1 the condition `0.1 > |DELTA_PNL| + 0.10` requires a near-zero drop and is rejected as a proposal (`00_globals.md` §11-R10).

## 5. Parameterization & schema

| Doc var | Live key | Unit | Proposed | Schema default | Notes |
|---|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | percent, signed < 0 | **−0.4** | −0.4 | source live −0.1 kept as sweep point (R10) |
| `entry_offset_seconds` | `entryOffsetSeconds` | seconds | **3** | 5 | bound ≥ 2 |
| `exit_offset_seconds` | `exitOffsetSeconds` | seconds | **6** | 6 | bound **> 5** (R2); source live was 4 — superseded |
| — | `amountUsd` | USD | 10 | 20 | |
| — | `leverage` | int | 5 (per-exchange delta may override, e.g. 4) | 4 | margin only, never a P&L multiplier |
| — | `taker_fee_pct` *(exchange profile)* | percent | 0.05 | 0.05 | per-exchange |

`exit_offset_seconds` is the parameter whose live history (4 s) violates the new bound — configs must be migrated, not aliased.
