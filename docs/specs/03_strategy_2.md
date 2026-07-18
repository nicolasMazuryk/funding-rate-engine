# Strategy 2 — Negative Funding LONG, Trailing-Retracement Exit

**Document:** `03_strategy_2.md` · includes `00_globals.md` by reference · group common logic: `00_globals.md` §G-L
**Exit policy kind:** `sl_tp_deadline_retracement_funding_event`

**Conclusion first.** S2 collects the funding payment like S1/S1-WS but refuses to realize the drop immediately: it waits for a retracement, chasing the running low with a trailing TP limit that is re-derived every time a new low prints — tracking must be causal, driven only by lows observed so far, never by a future low. Timing risk concentrates in (a) the SL-only window between entry and `T_drop` arming, and (b) the no-recovery path (§2.3 of globals), which the SL/deadline pair must bound — with `retracementPct = 1.0` (full recovery to the anchor), deadline exits will be **frequent**, and the spec requires that frequency to be monitored and survivable.

---

## 1. Selection logic

Identical to S1/S1-WS — `00_globals.md` §G-L, no deltas.

## 2. Execution flow

| # | Time (rel.) | Action | Order / event | Price formula | Cancel/expiry |
|---|---|---|---|---|---|
| 1 | `T_settle − entryOffsetSeconds` | decide entry; record `anchorPrice` = reference price at decision time | BUY MARKET via **WS adapter** (mandatory; REST fallback only where the exchange profile enables it) | best ask | — |
| 2 | on entry fill (`P_entry`) | place stop-loss, active immediately | SELL STOP-MARKET reduce-only | `P_SL = P_entry × (1 − |F| × slMultiplier / 100)` | cancelled on TP/deadline exit |
| 3 | on funding gate open (WS `funding_fee` event; REST poll safety net; fallback at `T_settle + fundingFeeTimeoutSeconds`) | **arm the retracement tracker** | — | — | — |
| 4 | while tracking (1 s price poll) | maintain running `P_low` (lowest since arming); on each new low: cancel previous TP, re-place | SELL LIMIT reduce-only | `P_target = P_low + (anchorPrice − P_low) × retracementPct` | throttle: ≤ 1 re-place per second |
| 5 | first of: SL trigger / TP fill / `T_settle + deadlineSeconds` | exit (see §3) | — | — | siblings cancelled; post-exit sweep |

- The tracker is **re-spawned from the database on engine recovery** — a restart mid-position does not lose the trailing TP.
- Until step 3, only the SL is live: there is a deliberate window right after settlement with no TP.
- Code refs: `src/execution/strategies/strategy_2.ts`, `src/execution/execution/manager.ts` (retracement tracker).

## 3. Exit policy

**Kind:** `sl_tp_deadline_retracement_funding_event`.

| Path | Order | Price | Fee class | `exit_reason` |
|---|---|---|---|---|
| Stop-loss | SELL STOP-MARKET (reduce-only), active from entry fill | trigger `P_SL = P_entry × (1 − |F| × slMultiplier/100)`; fills at market (gap-through if price jumps past the trigger) | taker | `sl_hit` |
| Trailing TP | SELL LIMIT (reduce-only), current `P_target` | `P_low_running + (anchorPrice − P_low_running) × retracementPct` | maker | `tp_hit` |
| Deadline | SELL MARKET (reduce-only) at `T_settle + deadlineSeconds` | market − slippage | taker | `deadline` |

**`retracementPct = 1.0` (proposed, carried from live): the TP sits back at the anchor** — full recovery demanded before exiting. Given recovery is empirically not guaranteed, this maximizes both the win size and the deadline-exit frequency. **Binding requirements:**

1. Live monitoring must track the **deadline-exit frequency**; expect it to be substantial (the V-retrace is only one of three observed paths).
2. The SL (`slMultiplier`, proposed 2.0 → stop at `2×|F|` below entry) and the deadline together must bound the no-recovery path such that the loss on `sl_hit`/`deadline` exits, netted against funding, keeps the strategy's tail acceptable — validated against live results, with `retracementPct` tunable within `{0.5, 0.618, 0.8, 1.0}` for sensitivity testing.

## 4. P&L decomposition & profit condition

```
IF sl_hit:      DELTA_PNL = (P_SL_fill − P_entry)/P_entry × 100      # P_SL_fill = stop price − slippage (or worse gap-through)
                FEES      = takerFeePct × 2
IF tp_hit:      DELTA_PNL = (P_target − P_entry)/P_entry × 100
                FEES      = takerFeePct + makerFeePct
IF deadline:    DELTA_PNL = (P_deadline_fill − P_entry)/P_entry × 100
                FEES      = takerFeePct × 2

FUNDING_PNL = +|F|            # iff entry fill < T_settle (00_globals.md §3.1); an SL fill before T_settle → 0
NET_PNL     = DELTA_PNL + FUNDING_PNL − FEES
```

**Profit condition (expectation form):** `|F| + E[DELTA_PNL] > E[FEES]`. With `retracementPct = 1.0`, `DELTA_PNL ≈ (anchorPrice − P_entry)/P_entry ≈ 0` on `tp_hit` (anchor ≈ entry decision price), so TP wins ≈ `|F| − (taker + maker)` — clean funding capture. The strategy's expectancy is therefore dominated by how often the price **fails** to recover: per-path,
`E[NET] ≈ p_tp·(|F| − 0.07) + p_sl·(|F| − 2|F|·slMult/2... )` — concretely at `|F| = 0.4`, slMult 2.0, fees 0.05/0.02: TP path ≈ +0.33%, SL path ≈ 0.4 − 0.8 − 0.10 = −0.50%, deadline path in between. Break-even requires roughly `p_sl+deadline-loss` weighted below ~40% — live monitoring must confirm the realized path mix.

Edge case: an SL fill **before** `T_settle` (drop starting a candle early — observed, §2.1 of globals) loses the funding leg too; the accrual test handles this automatically.

## 5. Parameterization & schema

| Doc var | Live key | Unit | Proposed | Schema default | Notes |
|---|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | percent, signed < 0 | **−0.4** | −0.4 | R10; source live −0.1 as sweep point |
| `entry_offset_seconds` | `entryOffsetSeconds` | seconds | **3** | 5 | |
| `retracement_pct` | `retracementPct` | **fraction [0,1]** — the only fraction-unit key in the system | **1.0** | 0.5 | 1.0 = TP at anchor; source's Fibonacci `[0.3, 0.618]` range superseded (R8) |
| `sl_mult` | `slMultiplier` | multiplier on `|F|` | **2.0** | 1.0 | bound 0.5–4.0 |
| `T_deadline` | `deadlineSeconds` | seconds | **900** | 900 | bound 10–3600 (R3) |
| `ws_timeout` | `fundingFeeTimeoutSeconds` | seconds | **30** | 30 | tracker-arming fallback, not an exit |
| — | `amountUsd` / `leverage` | USD / int | 10 / 5 | 20 / 4 | |
| — | `poll_interval_seconds` *(engine constant)* | seconds | 1 | 1 | price poll; not operator-tunable |
| — | `replace_throttle_seconds` *(engine constant)* | seconds | 1 | 1 | ≤ 1 TP re-place per second |
| — | fees, per `00_globals.md` §8.2 | | | | |

**Defect-risk callout:** `retracementPct` is the lone fraction among percent-unit keys — the mirror image of the `takeProfitPct` hazard. The loader must reject `retracement_pct > 1.0` (someone entering `50` meaning 50%).
