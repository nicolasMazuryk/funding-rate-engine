# Strategy 4.1a — Post-Funding LONG Ladder, No Funding

**Document:** `05_strategy_4_1a.md` · includes `00_globals.md` by reference · group common logic: `00_globals.md` §G-R
**Exit policy kind:** `sl_tp_deadline` · **Backtestable:** yes (per-rung fill simulation)

**Conclusion first.** S4.1a pre-places a ladder of buy limits below the pre-event price, scaled by `|F|`, to be filled *by* the drop, and exits on a TP above the fill-weighted average. It receives **no funding, ever** (`FUNDING_PNL = 0` unconditionally — §G-R, reconciliation R7); the entire edge is delta recovery, which is empirically not guaranteed. Parity is achievable with per-rung trade-through fills and strict same-candle discipline (most rungs fill inside `drop_candle`; protective orders act only from the next candle). Timing risk concentrates in the no-recovery path — the funding-scaled SL plus the deadline must price it — and the single largest spec-level hazard is the `takeProfitPct` unit (percent vs fraction; loader guard, `00_globals.md` §11.2 / §13-R4).

---

## 1. Selection logic

```
AT T_settle − entryOffsetSeconds:
  IF F_predicted ≤ negativeFundingThresholdPercent AND market.status == 'trading' AND guards pass
  THEN trigger intent
```

Additional feasibility gate at trigger time (before any order): if even the **top** rung — the most favorably priced — fails the exchange `minCost` at the split quantity, the symbol is **skipped entirely** (§G-R).

## 2. Execution flow

**RECONCILIATION R11 applies:** the order lifecycle below is normative and supersedes the source extract (which placed SL and TP only after post-settlement rung cancellation). It is **identical in live and backtest**.

```
1. AT T_settle − entryOffsetSeconds:
   → Record P_ref (current price)
   → ladder_top    = P_ref × (1 − |F| × ladderTopMult    / 100)
   → ladder_bottom = P_ref × (1 − |F| × ladderBottomMult / 100)        # bottom > top offset, loader-enforced
   → prices[i] = ladder_top − i × (ladder_top − ladder_bottom) / (ladderCount − 1),  i ∈ [0, ladderCount−1]
   → qty[i]: amountUsd split across rungs by largest-remainder distribution over the lot step
             (rungs need not be equal; rungs below min-notional are DROPPED at placement,
              so the ladder may go out with fewer than ladderCount orders)
   → PLACE all rung BUY LIMITs
   → PLACE the STOP-LOSS together with the ladder, immediately:
        engine-side conditional STOP (SELL, reduce-only on trigger) at
        P_SL = P_avg_full × (1 − |F| × slMultiplier / 100)
        where P_avg_full = Σ prices[i]·qty[i] / Σ qty[i]  over the rungs actually placed
        — computable in advance from the known rung prices and quantities.
        On trigger it market-closes WHATEVER QTY IS CURRENTLY FILLED (reduce-only);
        it is engine-tracked, not an exchange resting order, until a position exists.

2. FILLS arrive during/after the drop (a rung may also fill BEFORE T_settle:
   logged `ladder.pre_funding_fill` + ops event; position KEPT; FUNDING_PNL still 0 — §G-R).

3. ON each rung fill:
   → recompute P_avg = fill-weighted average of FILLED rungs
   → FIRST fill: place TAKE-PROFIT SELL LIMIT (reduce-only) at P_avg × (1 + takeProfitPct / 100), qty = filled qty
   → EACH SUBSEQUENT (lower) fill: cancel + re-place the TP at the new P_avg-derived price and new qty
   (the SL price does NOT move — it stays anchored to P_avg_full from step 1)

4. UNFILLED RUNGS ARE CANCELLED ONLY AFTER the TP or SL fills, or the deadline/other exit fires
   — never earlier. A rung filling while the exit is in flight is closed by the
   protective reduce-only market close (cancel/fill race, §G-R).

5. EXIT: first of SL / TP / deadline (T_settle + deadlineSeconds → SELL MARKET reduce-only + cancel all).

6. IF ZERO rungs ever fill by the deadline: cancel all; intent terminates error_code = ladder_no_fills
   (no position, no exit_reason).
```

**Consequences of the R11 lifecycle (state them, don't discover them in prod):**
- The SL anchored to `P_avg_full` while only upper rungs are filled sits *further below* the actual average than `|F|×slMult` — protection is looser early, tighter as the ladder fills. Deterministic and identical in both implementations.
- Keeping unfilled rungs open until exit means a late dip can add exposure *after* the TP is resting — the TP re-place on each fill (step 3) keeps the exit sized correctly.

Code ref: `src/execution/strategies/strategy_4_1a.ts`.

## 3. Exit policy

**Kind:** `sl_tp_deadline`.

| Path | Order | Price | Fee class | `exit_reason` |
|---|---|---|---|---|
| Take-profit | SELL LIMIT reduce-only (re-placed per fill) | `P_avg × (1 + takeProfitPct/100)` | maker | `tp_hit` |
| Stop-loss | conditional SELL STOP-MARKET reduce-only | trigger `P_avg_full × (1 − |F| × slMultiplier/100)`; market − slippage, gap-through | taker | `sl_hit` |
| Deadline | SELL MARKET reduce-only at `T_settle + deadlineSeconds` | market − slippage | taker | `deadline` |
| No-fill termination | cancel all rungs | — | — | `error_code = ladder_no_fills` |

SL-vs-TP ambiguity: SL-first (§5.5.3). Entry(rung)-vs-SL ambiguity on one candle: both fire, worst outcome (§5.5.4).

## 4. P&L decomposition & profit condition

```
P_avg       = Σ filled_price[i] × qty[i] / Σ qty[i]
DELTA_PNL   = (P_exit − P_avg) / P_avg × 100
FUNDING_PNL = 0                                   # unconditional for 4.* (§G-R, R7)
FEES        = num_filled_rungs-weighted maker entries + exit fee
            = makerFeePct (entry, per filled notional) + [makerFeePct if tp_hit else takerFeePct]
NET_PNL     = DELTA_PNL − FEES
```

**Profit condition:** `DELTA_PNL > FEES`, i.e. on the TP path `takeProfitPct > makerFeePct + makerFeePct` → at proposed fees, `takeProfitPct > 0.04`. Proposed `takeProfitPct = 0.3` clears it 7×; the source live value `0.003` would sit **below one maker fee** and is rejected by the unit guard (R4). The real economics are in the path mix: SL path loses ≈ `|F| × slMultiplier` (from `P_avg_full`, minus fill-mix effects) plus fees with no funding cushion; deadline path is unbounded-ish downside capped only by time. The backtest must report fill-count distribution, path mix, and `NET_PNL` conditioned on the three recovery regimes of `00_globals.md` §2.3.

## 5. Parameterization & schema parity

| Doc var | Backtest key | Live key | Unit | Proposed | Schema default | Notes |
|---|---|---|---|---|---|---|
| `F_threshold` | `negative_funding_threshold_percent` | `negativeFundingThresholdPercent` | percent, signed < 0 | **−0.4** | −0.4 | source live −0.1 as sweep point (R10) |
| `entry_offset_seconds` | `entry_offset_seconds` | `entryOffsetSeconds` | seconds | **3** | 5 | ladder placement time |
| `ladder_count` | `ladder_count` | `ladderCount` | integer | **5** | 5 | bound 2–20 |
| `ladder_top_mult` | `ladder_top_mult` | `ladderTopMult` | multiplier on `|F|` | **0.7** | 0.5 | |
| `ladder_bottom_mult` | `ladder_bottom_mult` | `ladderBottomMult` | multiplier on `|F|` | **1.8** | 1.5 | loader: must be > `ladder_top_mult` |
| `TP_pct` | `take_profit_pct` | `takeProfitPct` | **percent — 0.3 means 0.30% (30 bp). Backtest key: percent. Live key: percent. Stated twice deliberately: this key is the highest-risk unit-mismatch candidate in the system.** Loader guard: value < 0.05 → hard error `unit_suspect_fraction` | **0.3** | 0.2 | source live `0.003` ⚠ rejected (R4) |
| `sl_mult` | `sl_multiplier` | `slMultiplier` | multiplier on `|F|` | **2.5** | 1.0 | bound 0.5–4.0 |
| `T_deadline` | `deadline_seconds` | `deadlineSeconds` | seconds | **1800** | 1800 | bound 10–3600 (R3) |
| — | `amount_usd` / `leverage` | `amountUsd` / `leverage` | USD / int | 10 / 5 | 20 / 4 | `amountUsd` split across rungs |
| — | fees / slippage / latency | per `00_globals.md` §10.2 | | | | |

Both schemas generated from the canonical schema (`00_globals.md` §11.2); a hand-written config in the wrong shape is rejected.

## 6. Backtest simulation rules

1. **Placement:** all rungs + the conditional SL become effective at decision + 1 s (latency; stagger folds into the candle). Quantity split by largest-remainder over lot step; sub-min-notional rungs dropped; symbol skipped if the top rung fails `minCost`.
2. **Rung fills:** each BUY LIMIT fills on **trade-through only** (`low < prices[i]` strictly), earliest on its effective candle. Multiple rungs may fill on one candle (typically `drop_candle`).
3. **TP lifecycle:** first fill → TP effective from the **candle after** the placing decision (latency), and — binding — **no rung's TP may act on the candle that rung filled**; where rungs fill inside `drop_candle`, the TP (a fill-gated protective order) acts from `drop_candle + 1` at that candle's prices. Each deeper fill re-prices the TP; the re-placed TP is effective next candle. Fills on trade-through (`high > P_TP` strictly), maker.
4. **SL:** conditional from the placement candle; trigger `low ≤ P_SL` **while filled qty > 0**; fills market − slippage/gap-through on the trigger candle; may act on the same candle as a rung fill, resolving pessimistically (§5.5.4: rung fills *and* SL exits that candle at the stop or worse).
5. **Deadline:** `T_settle + deadline_seconds` → cancel all rungs, market-close filled qty (+ latency, − slippage), taker.
6. **Cancel/fill race:** if a rung fill lands on the same candle as the exit/cancel decision, the fill stands and a protective reduce-only market close executes next candle (taker, slippage) — matching the live race handler.
7. **Funding:** `FUNDING_PNL = 0` on every path, including pre-settlement rung fills (logged in output as `pre_settle_fill_count` for audit).
8. **No-fill:** zero fills by deadline → `error_code = ladder_no_fills`, fees 0.
9. **Report:** fill-count histogram, `P_avg` vs `P_ref` distribution, path mix, regime-conditioned P&L, sensitivity over `takeProfitPct` and `slMultiplier`.

### Parity ledger — Strategy 4.1a

| Live behavior | Backtest treatment |
|---|---|
| Per-rung limit fills | **Modeled conservatively** — trade-through only (bias: fewer, worse fills) |
| Largest-remainder qty split, min-notional drops, top-rung skip | **Modeled faithfully** |
| SL placed with ladder at `P_avg_full` (R11 lifecycle) | **Modeled faithfully** — identical rule both sides |
| TP placed on first fill, re-placed per fill | **Modeled conservatively** — next-candle effectiveness, no action on the filling candle, `drop_candle + 1` discipline |
| Pre-settlement rung fill kept, funding | **Modeled conservatively** — position kept, `FUNDING_PNL = 0` even if the venue credits it (R7; bias: against) |
| Cancel/fill race → protective close | **Modeled conservatively** — next-candle taker close |
| Unfilled rungs live until exit | **Modeled faithfully** |
| Deadline close | **Modeled faithfully** — latency + slippage |
| Predicted-rate selection | **Named optimism** — settled-rate proxy |
| Kill switch / orphan sweep / restarts | **Not modeled** — operational |
