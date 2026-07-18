# Strategy 4.2a — Post-Funding LONG Single Limit

**Document:** `06_strategy_4_2a.md` · includes `00_globals.md` by reference · group common logic: `00_globals.md` §G-R
**Exit policy kind:** `sl_tp_deadline`

**Conclusion first.** S4.2a is the ladder collapsed to a single resting buy limit at a funding-scaled offset below the pre-event price — one fill, one `P_entry`, no averaging. `FUNDING_PNL` is the actual exchange-accrued amount (§G-R) — 0 in the common case since the limit is meant to fill after `T_settle`, but real and exchange-sourced on a pre-settlement fill, never hardcoded. The two things the spec must nail are (a) the `limit_expired` no-fill terminal path, undocumented in the source and now normative (R5), and (b) the loader constraint `slMultiplier > limitOffsetMult`, without which the stop sits **above** the entry limit and the position is stopped out by construction. Same `takeProfitPct` unit hazard as 4.1a. Timing risk concentrates in fill selectivity: a single limit at `0.75×|F|` below reference either catches the drop or misses the event entirely — expect a high `limit_expired` rate in shallow-drop events, which is a cost of zero (minus opportunity), not a loss.

---

## 1. Selection logic

Identical to 4.1a §1 (threshold, guards), plus feasibility: skip the symbol if the single limit's qty fails lot-step/`minCost`.

## 2. Execution flow

```
1. AT T_settle − entryOffsetSeconds:
   → Record P_ref (current price)
   → PLACE BUY LIMIT at  P_limit = P_ref × (1 − |F| × limitOffsetMult / 100)
     with expireAt = T_settle + deadlineSeconds
   → PLACE the conditional STOP-LOSS together with the entry limit (R11 lifecycle,
     mirrored from 4.1a — single-rung case):
       P_SL = P_limit × (1 − |F| × slMultiplier / 100)     # computable in advance
     engine-tracked conditional; on trigger, market-closes the filled qty reduce-only.
     Loader guarantees slMultiplier > limitOffsetMult, so P_SL < P_limit always.

2. IF the limit fills at P_fill (intended: during the post-settlement drop;
   a pre-settlement fill is logged, kept, and its funding is whatever the exchange
   actually accrues, per §3.1 — §G-R):
   → PLACE TAKE-PROFIT: SELL LIMIT reduce-only at P_fill × (1 + takeProfitPct / 100)
   → SL + TP form the protective pair from that point (OCO semantics)

3. EXIT: first of SL / TP / deadline (T_settle + deadlineSeconds → SELL MARKET reduce-only,
   cancel anything resting).

4. IF the limit NEVER fills by expireAt:
   → cancel the limit; intent terminates with error_code = limit_expired
     (no position, no SL/TP consequences, no fees). Normative terminal state (R5).
     Common in low-volatility post-settlement windows where price never dips to P_limit.
```

**RECONCILIATION vs source:** the source placed the SL only after the fill. Under R11 (framework mandate, mirrored from 4.1a) the SL is placed with the entry limit — its price depends only on `P_limit`, which is known at placement. Practical effect: protection exists from the first possible fill instant, including a fill that lands during the violent seconds of the drop itself.

Code refs: `src/execution/execution/manager.ts:2642` (`setError limit_expired`).

## 3. Exit policy

**Kind:** `sl_tp_deadline`.

| Path | Order | Price | Fee class | `exit_reason` / `error_code` |
|---|---|---|---|---|
| Take-profit | SELL LIMIT reduce-only | `P_fill × (1 + takeProfitPct/100)` | maker | `tp_hit` |
| Stop-loss | conditional SELL STOP-MARKET reduce-only | trigger `P_limit × (1 − |F| × slMultiplier/100)`; market − slippage, gap-through | taker | `sl_hit` |
| Deadline | SELL MARKET reduce-only at `T_settle + deadlineSeconds` | market − slippage | taker | `deadline` |
| No fill | cancel entry limit at `expireAt` | — | none | `error_code = limit_expired` |

With `slMultiplier > limitOffsetMult`, a fill-and-immediate-stop is a real path on deep drop candles: the limit fills and the SL triggers within the same second.

## 4. P&L decomposition & profit condition

```
DELTA_PNL   = (P_exit − P_fill) / P_fill × 100
FUNDING_PNL = funding_accrued_actual                   # exchange-sourced (11 §9), per §3.1; 0 unless a pre-T_settle fill (§G-R)
FEES        = makerFeePct (entry) + [makerFeePct if tp_hit else takerFeePct]
NET_PNL     = DELTA_PNL + FUNDING_PNL − FEES
limit_expired path: NET_PNL = 0, no fees.
```

**Profit condition (TP path):** `takeProfitPct + FUNDING_PNL > 2 × makerFeePct` → in the common case (`FUNDING_PNL = 0`) proposed 0.2 > 0.04 ✓; a pre-settlement fill's real exchange-accrued funding shifts this by the exact accrued amount, never assumed. SL path loses `≈ (P_fill − P_SL)/P_fill × 100 ≤ |F| × (slMultiplier − limitOffsetMult)` plus fees (`P_fill ≤ P_limit`, so the realized SL distance can only be tighter than the placement geometry). Expectancy = `p_tp·(TP − fees) − p_sl·(SL_dist + fees) − p_deadline·E[loss|deadline]`, with `p_fill` itself a free parameter of `limitOffsetMult` — deeper offsets fill less often but at better prices. Live monitoring must report the fill-rate / conditional-P&L trade-off across `limitOffsetMult ∈ {0.5, 0.75, 1.0, 1.25}`.

## 5. Parameterization & schema

| Doc var | Live key | Unit | Proposed | Schema default | Notes |
|---|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | percent, signed < 0 | **−0.4** | −0.4 | R10 |
| `entry_offset_seconds` | `entryOffsetSeconds` | seconds | **5** | 5 | |
| `limit_offset_mult` | `limitOffsetMult` | multiplier on `|F|` | **0.75** | 0.75 | |
| `TP_pct` | `takeProfitPct` | **percent — 0.2 means 0.20%; loader guard `unit_suspect_fraction` on v < 0.05** (R4) | **0.2** | 0.2 | highest-risk unit key, same as 4.1a |
| `sl_mult` | `slMultiplier` | multiplier on `|F|` | **1.5** | 1.5 | bound 1.0–4.0 **and > `limit_offset_mult`** (else stop above entry) — loader-enforced |
| `T_deadline` | `deadlineSeconds` | seconds | **60** | 60 | bound 10–3600 |
| — | `amountUsd` / `leverage` | USD / int | 20 / 4 | 20 / 4 | source had no usable live config ("not deployed; live config unusable as written") — schema defaults are the proposal baseline |
| — | fees, per `00_globals.md` §8.2 | | | | |

**Schema-shape warning (binding, carried from source):** the engine config must be generated from the one canonical schema — a hand-written config in the wrong shape is rejected (or worse, misread). See `00_globals.md` §9.2.
