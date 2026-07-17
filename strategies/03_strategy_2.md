# Strategy 2 — Negative Funding LONG, Trailing-Retracement Exit

**Document:** `03_strategy_2.md` · includes `00_globals.md` by reference · group common logic: `00_globals.md` §G-L
**Exit policy kind:** `sl_tp_deadline_retracement_funding_event` · **Backtestable:** yes, with a causal tracker emulation

**Conclusion first.** S2 collects the funding payment like S1/S1-WS but refuses to realize the drop immediately: it waits for a retracement, chasing the running low with a trailing TP limit that is re-derived every time a new low prints. Parity is achievable **only** if the backtester simulates the tracker causally — running minimum, armed at `T_drop`, throttled re-places, trade-through fills strictly after `drop_candle`. A backtest that places one limit at the target derived from the *final* low is optimistic twice over (knows the low, and knows it early) and is rejected. Timing risk concentrates in (a) the SL-only window between entry and `T_drop` arming, and (b) the no-recovery path (§2.3 of globals), which the SL/deadline pair must bound — with `retracementPct = 1.0` (full recovery to the anchor), deadline exits will be **frequent**, and the spec requires that frequency to be reported and survivable.

---

## 1. Selection logic

Identical to S1/S1-WS — `00_globals.md` §G-L, no deltas.

## 2. Execution flow

| # | Time (rel.) | Action | Order / event | Price formula | Cancel/expiry |
|---|---|---|---|---|---|
| 1 | `T_settle − entryOffsetSeconds` | decide entry; record `anchorPrice` = reference price at decision time | BUY MARKET via **WS adapter** (mandatory; OKX-only REST fallback) | best ask (+ slippage in backtest) | — |
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
| Stop-loss | SELL STOP-MARKET (reduce-only), active from entry fill | trigger `P_SL = P_entry × (1 − |F| × slMultiplier/100)`; fills at market − slippage (gap-through per §5.5.5) | taker | `sl_hit` |
| Trailing TP | SELL LIMIT (reduce-only), current `P_target` | `P_low_running + (anchorPrice − P_low_running) × retracementPct` | maker | `tp_hit` |
| Deadline | SELL MARKET (reduce-only) at `T_settle + deadlineSeconds` | market − slippage | taker | `deadline` |

**`retracementPct = 1.0` (proposed, carried from live): the TP sits back at the anchor** — full recovery demanded before exiting. Given recovery is empirically not guaranteed, this maximizes both the win size and the deadline-exit frequency. **Binding requirements:**

1. The backtest report must state the **deadline-exit frequency**; expect it to be substantial (the V-retrace is only one of three observed paths).
2. The SL (`slMultiplier`, proposed 2.0 → stop at `2×|F|` below entry) and the deadline together must bound the no-recovery path such that the loss on `sl_hit`/`deadline` exits, netted against funding, keeps the strategy's tail acceptable — validated in backtest, with a sensitivity sweep over `retracementPct ∈ {0.5, 0.618, 0.8, 1.0}`.
3. SL-vs-TP same-candle conflicts resolve **SL-first** (`00_globals.md` §5.5.3).

## 4. P&L decomposition & profit condition

```
IF sl_hit:      DELTA_PNL = (P_SL_fill − P_entry)/P_entry × 100      # P_SL_fill = stop price − slippage (or worse gap-through)
                FEES      = takerFeePct × 2
IF tp_hit:      DELTA_PNL = (P_target − P_entry)/P_entry × 100
                FEES      = takerFeePct + makerFeePct
IF deadline:    DELTA_PNL = (P_deadline_fill − P_entry)/P_entry × 100
                FEES      = takerFeePct × 2

FUNDING_PNL = +|F|            # iff entry fill < T_settle (00_globals.md §5.1); an SL fill before T_settle → 0
NET_PNL     = DELTA_PNL + FUNDING_PNL − FEES
```

**Profit condition (expectation form):** `|F| + E[DELTA_PNL] > E[FEES]`. With `retracementPct = 1.0`, `DELTA_PNL ≈ (anchorPrice − P_entry)/P_entry ≈ 0` on `tp_hit` (anchor ≈ entry decision price), so TP wins ≈ `|F| − (taker + maker)` — clean funding capture. The strategy's expectancy is therefore dominated by how often the price **fails** to recover: per-path,
`E[NET] ≈ p_tp·(|F| − 0.07) + p_sl·(|F| − 2|F|·slMult/2... )` — concretely at `|F| = 0.4`, slMult 2.0, fees 0.05/0.02: TP path ≈ +0.33%, SL path ≈ 0.4 − 0.8 − 0.10 = −0.50%, deadline path in between. Break-even requires roughly `p_sl+deadline-loss` weighted below ~40% — the backtest must confirm the path mix.

Edge case: an SL fill **before** `T_settle` (drop starting a candle early — observed, §2.1 of globals) loses the funding leg too; the accrual test handles this automatically.

## 5. Parameterization & schema parity

| Doc var | Backtest key | Live key | Unit | Proposed | Schema default | Notes |
|---|---|---|---|---|---|---|
| `F_threshold` | `negative_funding_threshold_percent` | `negativeFundingThresholdPercent` | percent, signed < 0 | **−0.4** | −0.4 | R10; source live −0.1 as sweep point |
| `entry_offset_seconds` | `entry_offset_seconds` | `entryOffsetSeconds` | seconds | **3** | 5 | |
| `retracement_pct` | `retracement_pct` | `retracementPct` | **fraction [0,1]** — the only fraction-unit key in the system | **1.0** | 0.5 | 1.0 = TP at anchor; source's Fibonacci `[0.3, 0.618]` range superseded (R8) |
| `sl_mult` | `sl_multiplier` | `slMultiplier` | multiplier on `|F|` | **2.0** | 1.0 | bound 0.5–4.0 |
| `T_deadline` | `deadline_seconds` | `deadlineSeconds` | seconds | **900** | 900 | bound 10–3600 (R3) |
| `ws_timeout` | `funding_fee_timeout_seconds` | `fundingFeeTimeoutSeconds` | seconds | **30** | 30 | tracker-arming fallback, not an exit |
| — | `amount_usd` / `leverage` | `amountUsd` / `leverage` | USD / int | 10 / 5 | 20 / 4 | |
| — | `poll_interval_seconds` | *(engine constant)* | seconds | 1 | 1 | price poll; not operator-tunable |
| — | `replace_throttle_seconds` | *(engine constant)* | seconds | 1 | 1 | ≤ 1 TP re-place per second |
| — | `ws_event_miss_rate` | *(backtest-only)* | fraction | 0.02 | 0.02 | arming falls back to timeout |
| — | fees / slippage / latency | per `00_globals.md` §10.2 | | | | |

**Defect-risk callout:** `retracementPct` is the lone fraction among percent-unit keys — the mirror image of the `takeProfitPct` hazard. The loader must reject `retracement_pct > 1.0` (someone entering `50` meaning 50%).

## 6. Backtest simulation rules

1. **Entry & SL:** entry as S1 rule 1. SL active from the entry-fill candle (stop placement latency folded into the same candle — conservative is SL *late*, but for a protective order lateness is anti-conservative for realism vs pro-strategy for losses; resolve: SL active from `entry_candle` onward, and entry-vs-SL same-candle ambiguity resolves per `00_globals.md` §5.5.4).
2. **Arming:** tracker arms at `T_drop` (per §3 of globals), or at `T_settle + funding_fee_timeout_seconds` with probability `ws_event_miss_rate`, or at the `no_drop_localized` fallback (window edge). **Never at `T_settle`** — arming at `T_settle` lets the simulated tracker see lows the live tracker never sees (`00_globals.md` §5.3).
3. **Tracker (causal):** from the arming candle onward, once per candle (1 s poll): update `P_low_running = min(P_low_running, low(candle))`; if a new low printed, the re-placed TP at the new `P_target` becomes effective on the **next** candle (1 s latency + throttle). At most one re-place per candle.
4. **TP fills:** SELL LIMIT fills on **trade-through only** (`high > P_target` strictly), evaluated only on candles **strictly after `drop_candle`** and never on the candle whose low set the current target (the re-place isn't live yet), never on the entry candle. Maker fee.
5. **SL fills:** trigger when `low ≤ P_SL`; fill at `P_SL − slippage` or the gap-through price if worse. May fill on the entry candle (§5.5.1 exception). SL-first on any candle spanning both SL and TP.
6. **Deadline:** at `T_settle + deadline_seconds`, market close at next candle's bid − slippage, taker; all resting orders cancelled (sweep modeled implicitly).
7. **Funding:** `+|F_settled|` iff entry fill < `T_settle` **and** the position was not fully closed (SL) before `T_settle`.
8. **Report requirements:** path mix (`tp_hit` / `sl_hit` / `deadline` frequencies), deadline-exit `DELTA_PNL` distribution, sensitivity over `retracementPct` and `slMultiplier`.

### Parity ledger — Strategy 2

| Live behavior | Backtest treatment |
|---|---|
| Trailing TP re-derived from running low | **Modeled faithfully & causally** — running min from arming, next-candle effectiveness, 1/s throttle |
| Tracker armed on funding-fee event | **Modeled conservatively** — armed at `T_drop` (never `T_settle`); miss-rate fallback to timeout arming |
| TP limit fills | **Modeled conservatively** — trade-through only, never on `drop_candle`, never on the low-setting candle (bias: fewer maker fills) |
| SL stop-market | **Modeled conservatively** — SL-first conflicts, gap-through, slippage |
| Deadline market close | **Modeled faithfully** — with latency + slippage |
| Funding accrual (incl. pre-settle SL edge case) | **Modeled faithfully** — fill-time test |
| Engine-restart tracker re-spawn | **Not modeled** — boundary assumption: recovery restores the tracker with state intact; live telemetry must confirm re-spawn correctness (justification: no crash model in simulation) |
| Re-place cancel/fill race (TP fills while cancel in flight) | **Bounded** — the next-candle effectiveness rule means the simulated TP is never fresher than live's worst case |
| REST funding-fee poll | **Bounded** — between event-arming and timeout-arming paths |
| WS-mandatory order path / OKX REST fallback | **Not modeled** — latency conservatism dominates |
| Kill switch / sweeps | **Not modeled** — operational |
| Predicted-rate selection | **Named optimism** — settled-rate proxy (`00_globals.md` §5.2) |
