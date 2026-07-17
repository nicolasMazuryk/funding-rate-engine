# Strategy 4.2a — Post-Funding LONG Single Limit, No Funding

**Document:** `06_strategy_4_2a.md` · includes `00_globals.md` by reference · group common logic: `00_globals.md` §G-R
**Exit policy kind:** `sl_tp_deadline` · **Backtestable:** yes

**Conclusion first.** S4.2a is the ladder collapsed to a single resting buy limit at a funding-scaled offset below the pre-event price — one fill, one `P_entry`, no averaging. `FUNDING_PNL = 0` unconditionally (§G-R). Parity is the easiest of Group R; the two things the spec must nail are (a) the `limit_expired` no-fill terminal path, undocumented in the source and now normative (R5), and (b) the loader constraint `slMultiplier > limitOffsetMult`, without which the stop sits **above** the entry limit and the position is stopped out by construction. Same `takeProfitPct` unit hazard as 4.1a. Timing risk concentrates in fill selectivity: a single limit at `0.75×|F|` below reference either catches the drop or misses the event entirely — expect a high `limit_expired` rate in shallow-drop events, which is a cost of zero (minus opportunity), not a loss.

---

## 1. Selection logic

Identical to 4.1a §1 (threshold, guards, settled-rate proxy), plus feasibility: skip the symbol if the single limit's qty fails lot-step/`minCost`.

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
   a pre-settlement fill is logged, kept, and still earns no funding — §G-R):
   → PLACE TAKE-PROFIT: SELL LIMIT reduce-only at P_fill × (1 + takeProfitPct / 100)
   → SL + TP form the protective pair from that point (OCO semantics)

3. EXIT: first of SL / TP / deadline (T_settle + deadlineSeconds → SELL MARKET reduce-only,
   cancel anything resting).

4. IF the limit NEVER fills by expireAt:
   → cancel the limit; intent terminates with error_code = limit_expired
     (no position, no SL/TP consequences, no fees). Normative terminal state (R5).
     Common in low-volatility post-settlement windows where price never dips to P_limit.
```

**RECONCILIATION vs source:** the source placed the SL only after the fill. Under R11 (framework mandate, mirrored from 4.1a) the SL is placed with the entry limit — its price depends only on `P_limit`, which is known at placement. Practical effect: protection exists from the first possible fill instant, including intra-`drop_candle` fills.

Code refs: `src/execution/execution/manager.ts:2642` (`setError limit_expired`).

## 3. Exit policy

**Kind:** `sl_tp_deadline`.

| Path | Order | Price | Fee class | `exit_reason` / `error_code` |
|---|---|---|---|---|
| Take-profit | SELL LIMIT reduce-only | `P_fill × (1 + takeProfitPct/100)` | maker | `tp_hit` |
| Stop-loss | conditional SELL STOP-MARKET reduce-only | trigger `P_limit × (1 − |F| × slMultiplier/100)`; market − slippage, gap-through | taker | `sl_hit` |
| Deadline | SELL MARKET reduce-only at `T_settle + deadlineSeconds` | market − slippage | taker | `deadline` |
| No fill | cancel entry limit at `expireAt` | — | none | `error_code = limit_expired` |

SL-vs-TP: SL-first (§5.5.3). Entry-vs-SL on one candle: both fire, worst outcome (§5.5.4) — with `slMultiplier > limitOffsetMult` this is a real path on deep drop candles: filled and stopped in the same second.

## 4. P&L decomposition & profit condition

```
DELTA_PNL   = (P_exit − P_fill) / P_fill × 100
FUNDING_PNL = 0                                        # unconditional (§G-R)
FEES        = makerFeePct (entry) + [makerFeePct if tp_hit else takerFeePct]
NET_PNL     = DELTA_PNL − FEES
limit_expired path: NET_PNL = 0, no fees.
```

**Profit condition (TP path):** `takeProfitPct > 2 × makerFeePct` → proposed 0.2 > 0.04 ✓. SL path loses `≈ (P_fill − P_SL)/P_fill × 100 ≤ |F| × (slMultiplier − limitOffsetMult)` plus fees (`P_fill ≤ P_limit`, so the realized SL distance can only be tighter than the placement geometry). Expectancy = `p_tp·(TP − fees) − p_sl·(SL_dist + fees) − p_deadline·E[loss|deadline]`, with `p_fill` itself a free parameter of `limitOffsetMult` — deeper offsets fill less often but at better prices. The backtest must report the fill-rate / conditional-P&L trade-off across `limitOffsetMult ∈ {0.5, 0.75, 1.0, 1.25}`.

## 5. Parameterization & schema parity

| Doc var | Backtest key | Live key | Unit | Proposed | Schema default | Notes |
|---|---|---|---|---|---|---|
| `F_threshold` | `negative_funding_threshold_percent` | `negativeFundingThresholdPercent` | percent, signed < 0 | **−0.4** | −0.4 | R10 |
| `entry_offset_seconds` | `entry_offset_seconds` | `entryOffsetSeconds` | seconds | **5** | 5 | |
| `limit_offset_mult` | `limit_offset_mult` | `limitOffsetMult` | multiplier on `|F|` | **0.75** | 0.75 | |
| `TP_pct` | `take_profit_pct` | `takeProfitPct` | **percent — 0.2 means 0.20%; backtest and live both percent; loader guard `unit_suspect_fraction` on v < 0.05** (R4) | **0.2** | 0.2 | highest-risk unit key, same as 4.1a |
| `sl_mult` | `sl_multiplier` | `slMultiplier` | multiplier on `|F|` | **1.5** | 1.5 | bound 1.0–4.0 **and > `limit_offset_mult`** (else stop above entry) — loader-enforced |
| `T_deadline` | `deadline_seconds` | `deadlineSeconds` | seconds | **60** | 60 | bound 10–3600 |
| — | `amount_usd` / `leverage` | `amountUsd` / `leverage` | USD / int | 20 / 4 | 20 / 4 | source had no usable live config ("not deployed; live config unusable as written") — schema defaults are the proposal baseline |
| — | fees / slippage / latency | per `00_globals.md` §10.2 | | | | |

**Schema-shape warning (binding, carried from source):** backtest and engine config representations must be generated from the one canonical schema — a hand-written config in the wrong schema is rejected (or worse, misread) by the other side. See `00_globals.md` §11.2.

## 6. Backtest simulation rules

1. **Placement:** entry limit + conditional SL effective at decision + 1 s.
2. **Entry fill:** trade-through only (`low < P_limit` strictly), earliest on the effective candle; pre-settlement fills allowed, logged, `FUNDING_PNL = 0` regardless.
3. **TP:** placed on the fill; effective from `fill_candle + 1` (latency), and if the fill is on `drop_candle`, from `drop_candle + 1` at that candle's prices; fills trade-through (`high > P_TP`), never on the entry-fill candle (§5.5.1); maker.
4. **SL:** active (conditional on filled qty > 0) from placement; trigger `low ≤ P_SL`; may act on the entry-fill candle — entry-vs-SL ambiguity resolves to both firing, worst price (§5.5.4); market − slippage, gap-through.
5. **Deadline:** at `T_settle + deadline_seconds`: if filled, market close (+ latency, − slippage, taker) and cancel the TP/SL; if never filled, cancel the limit → `limit_expired`.
6. **Feasibility:** lot/minCost at placement; infeasible → skip symbol.
7. **Report:** fill rate, `limit_expired` rate, path mix, entry-vs-SL same-candle incidence (a direct read on how violent the fills are), sensitivity over `limitOffsetMult` × `slMultiplier`.

### Parity ledger — Strategy 4.2a

| Live behavior | Backtest treatment |
|---|---|
| Single limit entry | **Modeled conservatively** — trade-through only |
| SL placed with entry limit (R11) | **Modeled faithfully** — identical rule both sides |
| TP placed on fill | **Modeled conservatively** — next-candle effectiveness, `drop_candle + 1` discipline |
| `limit_expired` termination | **Modeled faithfully** — normative terminal state, zero P&L/fees (R5) |
| Pre-settlement fill kept, no funding | **Modeled conservatively** — `FUNDING_PNL = 0` (R7) |
| Entry-and-SL same candle | **Modeled pessimistically** — both fire, worst outcome |
| Deadline close / sweep | **Modeled faithfully** / implicit |
| Predicted-rate selection | **Named optimism** — settled-rate proxy |
| Kill switch / orphan handling | **Not modeled** — operational |
