# Strategy 4.1a — Post-Funding LONG Ladder, No Funding

**Document:** `05_strategy_4_1a.md` · includes `00_globals.md` by reference · group common logic: `00_globals.md` §G-R
**Exit policy kind:** `sl_tp_deadline`

**Conclusion first.** S4.1a pre-places a ladder of buy limits below the pre-event price, scaled by `|F|`, to be filled *by* the drop, and exits on a TP above the fill-weighted average. It receives **no funding, ever** (`FUNDING_PNL = 0` unconditionally — §G-R, reconciliation R7); the entire edge is delta recovery, which is empirically not guaranteed. Timing risk concentrates in the no-recovery path — the funding-scaled SL plus the deadline must price it — and the single largest spec-level hazard is the `takeProfitPct` unit (percent vs fraction; loader guard, `00_globals.md` §9.2 / §11-R4).

---

## 1. Selection logic

```
AT T_settle − entryOffsetSeconds:
  IF F_predicted ≤ negativeFundingThresholdPercent AND market.status == 'trading' AND guards pass
  THEN trigger intent
```

Additional feasibility gate at trigger time (before any order): if even the **top** rung — the most favorably priced — fails the exchange `minCost` at the split quantity, the symbol is **skipped entirely** (§G-R).

## 2. Execution flow

**RECONCILIATION R11 applies:** the order lifecycle below is normative and supersedes the source extract (which placed SL and TP only after post-settlement rung cancellation).

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

## 4. P&L decomposition & profit condition

```
P_avg       = Σ filled_price[i] × qty[i] / Σ qty[i]
DELTA_PNL   = (P_exit − P_avg) / P_avg × 100
FUNDING_PNL = 0                                   # unconditional for 4.* (§G-R, R7)
FEES        = num_filled_rungs-weighted maker entries + exit fee
            = makerFeePct (entry, per filled notional) + [makerFeePct if tp_hit else takerFeePct]
NET_PNL     = DELTA_PNL − FEES
```

**Profit condition:** `DELTA_PNL > FEES`, i.e. on the TP path `takeProfitPct > makerFeePct + makerFeePct` → at proposed fees, `takeProfitPct > 0.04`. Proposed `takeProfitPct = 0.3` clears it 7×; the source live value `0.003` would sit **below one maker fee** and is rejected by the unit guard (R4). The real economics are in the path mix: SL path loses ≈ `|F| × slMultiplier` (from `P_avg_full`, minus fill-mix effects) plus fees with no funding cushion; deadline path is unbounded-ish downside capped only by time. Live monitoring must report fill-count distribution, path mix, and `NET_PNL` conditioned on the three recovery regimes of `00_globals.md` §2.3.

## 5. Parameterization & schema

| Doc var | Live key | Unit | Proposed | Schema default | Notes |
|---|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | percent, signed < 0 | **−0.4** | −0.4 | source live −0.1 as sweep point (R10) |
| `entry_offset_seconds` | `entryOffsetSeconds` | seconds | **3** | 5 | ladder placement time |
| `ladder_count` | `ladderCount` | integer | **5** | 5 | bound 2–20 |
| `ladder_top_mult` | `ladderTopMult` | multiplier on `|F|` | **0.7** | 0.5 | |
| `ladder_bottom_mult` | `ladderBottomMult` | multiplier on `|F|` | **1.8** | 1.5 | loader: must be > `ladder_top_mult` |
| `TP_pct` | `takeProfitPct` | **percent — 0.3 means 0.30% (30 bp). This key is the highest-risk unit-mismatch candidate in the system.** Loader guard: value < 0.05 → hard error `unit_suspect_fraction` | **0.3** | 0.2 | source live `0.003` ⚠ rejected (R4) |
| `sl_mult` | `slMultiplier` | multiplier on `|F|` | **2.5** | 1.0 | bound 0.5–4.0 |
| `T_deadline` | `deadlineSeconds` | seconds | **1800** | 1800 | bound 10–3600 (R3) |
| — | `amountUsd` / `leverage` | USD / int | 10 / 5 | 20 / 4 | `amountUsd` split across rungs |
| — | fees, per `00_globals.md` §8.2 | | | | |

The live schema is generated from the canonical schema (`00_globals.md` §9.2); a hand-written config in the wrong shape is rejected.
