# Strategy 3a — Negative Funding SHORT, Ride the Drop

**Document:** `04_strategy_3a.md` · includes `00_globals.md` by reference · group common logic: `00_globals.md` §G-S
**Exit policy kind:** `sl_tp_deadline` · **Backtestable:** yes

**Conclusion first.** S3a inverts Group L: instead of collecting funding, it pays the funding fee as a short and bets the post-settlement drop exceeds it plus fees. The empirical drop model (§2 of globals: drop ≈ multiple of `|F|`) is *for* this strategy — the TP at `1.5×|F|` below entry sits inside the typical drop's depth. Parity is straightforward (no event-gated legs; the funding leg is a cost, applied by the same accrual rule with opposite sign). Timing risk concentrates in the 2–3 s pre-settlement window (an SL/TP fill before `T_settle` changes the funding leg to zero) and in OCO ambiguity on the violent drop candles, which resolves pessimistically. Note the deliberate design asymmetry: the **SL is a fixed percent** (`stopLossPercent`), not funding-scaled — flagged on its parameter row.

**Fleet constraint:** the loader rejects any engine enabling `strategy_3a` alongside a LONG strategy (1, 1WS, 2, 4.\*a) — they would offset inside the same funding window; S6 is exempt (`00_globals.md` §11.1).

---

## 1. Selection logic

Same family as §G-L (threshold key, guards, settled-rate proxy in backtest), direction SHORT:

```
AT T_settle − entryOffsetSeconds:
  IF F_predicted ≤ negativeFundingThresholdPercent AND market.status == 'trading' AND guards pass
  THEN trigger SHORT intent
```

## 2. Execution flow

| # | Time (rel.) | Action | Order | Price formula | Cancel/expiry |
|---|---|---|---|---|---|
| 1 | `T_settle − entryOffsetSeconds` | decide entry | SELL MARKET | best bid (− slippage in backtest); record `P_entry` = fill | — |
| 2 | immediately on fill | place OCO pair | BUY STOP-MARKET (SL, reduce-only) | trigger `P_entry × (1 + stopLossPercent / 100)` | cancelled on sibling fill / deadline |
| | | | BUY LIMIT (TP, reduce-only) | `P_entry × (1 − |F| × tpVariantAMultiplier / 100)` | cancelled on sibling fill / deadline |
| 3 | first of SL/TP/deadline | exit (§3) | — | — | post-exit sweep |

Not WS-mandatory (REST order path acceptable).

## 3. Exit policy

**Kind:** `sl_tp_deadline`.

| Path | Order | Price | Fee class | `exit_reason` |
|---|---|---|---|---|
| Take-profit | BUY LIMIT | `P_entry × (1 − |F| × tpVariantAMultiplier/100)` | maker | `tp_hit` |
| Stop-loss | BUY STOP-MARKET | trigger `P_entry × (1 + stopLossPercent/100)`; fills market + slippage, gap-through per §5.5.5 | taker | `sl_hit` |
| Deadline | BUY MARKET reduce-only at `T_settle + deadlineSeconds` | market + slippage | taker | `deadline` |

OCO semantics: first fill cancels the sibling; simultaneous/ambiguous candles resolve **SL-first** (`00_globals.md` §5.5.3). Deadline cancels both.

## 4. P&L decomposition & profit condition

```
IF tp_hit:    DELTA_PNL = +|F| × tpVariantAMultiplier            # short in profit, percent
              FEES      = takerFeePct + makerFeePct
IF sl_hit:    DELTA_PNL = −stopLossPercent − slippage_effect
              FEES      = takerFeePct × 2
IF deadline:  DELTA_PNL = (P_entry − P_exit)/P_entry × 100
              FEES      = takerFeePct × 2

FUNDING_PNL = −|F|        # shorts PAY on negative funding — iff open at T_settle (00_globals.md §5.1)
NET_PNL     = DELTA_PNL + FUNDING_PNL − FEES
```

**Profit condition:** `DELTA_PNL > |F| + FEES`. On the TP path: `|F|×tpMult − |F| − (taker+maker) > 0` ⇔ `|F| × (tpMult − 1) > taker + maker`. At proposed values (`tpMult = 1.5`, fees 0.07): requires `|F| > 0.14` — satisfied by any threshold ≤ −0.15; at threshold −0.4 the TP path nets ≈ `0.4×0.5 − 0.07 = +0.13%`. The strategy's expectancy hinges on TP hit-rate: empirically the drop reaches `≈2×|F|`, comfortably through a `1.5×|F|` TP **when the drop materializes**; the loss paths (no drop → deadline scratch −|F|−fees; spike up → −SL−|F|−fees = ≈ −1.5%) must be weighted in backtest.

**Funding edge case:** if the SL or TP fills **before** `T_settle` (drop starting early, or a pre-settlement spike), `FUNDING_PNL = 0` — the accrual test applies with opposite sign but identical mechanics.

## 5. Parameterization & schema parity

| Doc var | Backtest key | Live key | Unit | Proposed | Schema default | Notes |
|---|---|---|---|---|---|---|
| `F_threshold` | `negative_funding_threshold_percent` | `negativeFundingThresholdPercent` | percent, signed < 0 | **−0.4** | −0.4 | source live −0.1 / schema −0.5 consolidated (R10) |
| `entry_offset_seconds` | `entry_offset_seconds` | `entryOffsetSeconds` | seconds | **3** | 5 | |
| `SL_fixed` | `stop_loss_percent` | `stopLossPercent` | **percent, fixed — NOT a multiple of `|F|`** (contrast `slMultiplier` in S2/S4/S6) | **1.0** | 1.0 | bound 0.2–5.0; a 1.0% adverse move stops out regardless of funding magnitude |
| `TP_mult_3a` | `tp_variant_a_multiplier` | `tpVariantAMultiplier` | multiplier on `|F|` | **1.5** | 1.5 | TP distance = `|F| × 1.5` percent |
| `T_deadline` | `deadline_seconds` | `deadlineSeconds` | seconds | **900** | 300 | bound 10–3600 (R3) |
| — | `amount_usd` / `leverage` | `amountUsd` / `leverage` | USD / int | 10 / 5 | 20 / 4 | |
| — | fees / slippage / latency | per `00_globals.md` §10.2 | | 0.05 / 0.02 / 0.05 / 1000 | | |

Schema-shape note: `stopLossPercent` (fixed percent) vs `slMultiplier` (funding multiple) coexisting in the fleet is a foot-gun — an operator porting an SL value between S3a and S2 configs changes its meaning. Both loaders must reject the *other* key on this strategy (unknown-key = error, not ignore).

## 6. Backtest simulation rules

1. **Entry:** decision at `T_settle − entry_offset_seconds`; fill at decision + 1 s at bid proxy − slippage. Record `P_entry`.
2. **OCO placement:** both orders effective from `entry_candle + 1` (placement latency; per-exchange stagger folds into the same candle at 1 s resolution). **Exception per §5.5.1:** the SL may act on the entry candle itself if the range spans it — resolve pessimistically (entry filled and stopped same candle).
3. **TP fills:** BUY LIMIT on **trade-through only** (`low < P_TP` strictly). The TP is *not* credit-gated, so it **may fill on `drop_candle`** — the drop itself is what hits it — but never on the entry-fill candle (§5.5.1).
4. **SL:** trigger `high ≥ P_SL`; fill at `P_SL + slippage` or worse gap-through. SL-first on candles spanning both.
5. **Deadline:** market close at `T_settle + deadline_seconds` + latency, ask + slippage, taker; cancel both siblings.
6. **Funding:** charge `−|F_settled|` iff the position is still open at `T_settle` (fill-time test on the entry *and* on any pre-settle exit).
7. **Feasibility:** lot/minCost as usual.
8. **Report:** path mix, TP-hit rate vs `t_drop_offset_s`, distribution of drop depth ÷ `|F|` (validates the §2 empirical model).

### Parity ledger — Strategy 3a

| Live behavior | Backtest treatment |
|---|---|
| Market entry at bid | **Modeled conservatively** — touch + slippage + latency |
| TP limit fill | **Modeled conservatively** — trade-through only; drop-candle fills allowed (not credit-gated) but entry-candle fills forbidden |
| SL stop-market | **Modeled conservatively** — SL-first, gap-through, slippage |
| OCO cancel race (both legs fire in one candle) | **Modeled pessimistically** — SL-first ordering; live's post-exit sweep covers the residual (`00_globals.md` §7.2) |
| Funding charge at snapshot | **Modeled faithfully** — accrual rule, opposite sign |
| Deadline close | **Modeled faithfully** — latency + slippage |
| Predicted-rate selection | **Named optimism** — settled-rate proxy |
| Kill switch / sweeps / co-run guard | **Not modeled** (operational / config-time) |
