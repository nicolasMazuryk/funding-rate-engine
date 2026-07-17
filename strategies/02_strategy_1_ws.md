# Strategy 1 WS — Negative Funding LONG, Funding-Fee-Event Exit

**Document:** `02_strategy_1_ws.md` · includes `00_globals.md` by reference · group common logic: `00_globals.md` §G-L
**Exit policy kind:** `funding_fee_event` · **Backtestable:** yes, via `T_drop` emulation (`00_globals.md` §3, §5.3)

**Conclusion first.** Same funding-collection bet as S1, but the exit is gated on confirmation that funding actually accrued — the private WS `funding_fee` event (with REST-poll safety net and timeout fallback). This trades S1's fixed-clock variance for event-timing risk: the exit fires at `T_drop + reaction`, which by construction is **at or after** the drop begins. Parity is achievable because `T_drop` is the historical shadow of exactly the event the live engine waits on; the backtest must execute the exit no earlier than `drop_candle + 1`, with latency and an extra delay margin, and must exercise the timeout path at a nonzero rate. Timing risk concentrates in the gap between funding credit and exit fill — the strategy holds *through* the start of the drop by design, so its `DELTA_PNL` is systematically worse than a lucky S1 exit and better than an unlucky one.

---

## 1. Selection logic

Identical to S1 — `00_globals.md` §G-L, no deltas. (Same threshold key, same guards, same settled-rate proxy in backtest.)

## 2. Execution flow

| # | Time (rel.) | Action | Order / event | Price formula | Expiry/cancel |
|---|---|---|---|---|---|
| 1 | `T_settle − entryOffsetSeconds` | decide entry | BUY MARKET via **WS order adapter** (mandatory; engine throws at startup without one; OKX-only REST fallback on `WS_TIMEOUT`) | best ask (+ slippage in backtest) | — |
| 2 | after `T_settle` | await `ws.funding_fee` for (exchange, symbol) with `fundingTime` within ±5 s of `T_settle` | event | — | — |
| 2b | `T_settle + 3 s` | REST funding-fee poll fires, 8 s grace; observing the credit opens the funding gate exactly as the WS event would (`00_globals.md` §8) | REST | — | — |
| 3 | on gate open (WS or REST) | EXIT | SELL MARKET **reduce-only** at best bid (WS adapter) | bid (− slippage) | — |
| 4 | `T_settle + fundingFeeTimeoutSeconds`, if gate never opened | EXIT (fallback) | SELL MARKET reduce-only | bid (− slippage) | — |
| 5 | post-exit | `sweepReduceOnlyOrders` | cancels | — | — |

Observability: `intent.funding_gate_opened` / `intent.funding_gate_closed`. Code refs: `src/execution/execution/monitor.ts` (gate, REST poll), `src/execution/strategies/strategy_1_ws.ts`.

## 3. Exit policy

- **Kind:** `funding_fee_event`. Two exit paths, both SELL MARKET reduce-only, both **taker**:

| Path | Trigger | Timing | `exit_reason` |
|---|---|---|---|
| Event exit | funding gate opens (WS event or REST poll) | ≈ `T_drop` + reaction latency | `funding_fee_event` |
| Timeout exit | gate never opens | `T_settle + fundingFeeTimeoutSeconds` | `funding_fee_timeout` |

- No SL/TP/deadline beyond the timeout. The timeout is the delta-exposure cap: it must be long enough to avoid routine false timeouts (event lag ≤ 10 s empirically) and short enough to bound exposure — hence proposed 10 s (OKX 45 s, a measured venue delta).
- **Assumptions carried from source (still binding):** the private stream emits funding-fee events with enough symbol/funding-time context to match the intent; funding is credited at or before event observation; the reduce-only close path survives a WS order rejection via immediate REST fallback.
- **Failure mode to watch:** a *mismatched* event (wrong cycle inside the ±5 s tolerance) closes earlier than intended — tolerance is deliberately tight.

## 4. P&L decomposition & profit condition

```
DELTA_PNL   = (P_exit − P_entry) / P_entry × 100
FUNDING_PNL = +|F|                      # iff entry fill < T_settle (00_globals.md §5.1)
FEES        = takerFeePct × 2
NET_PNL     = DELTA_PNL + FUNDING_PNL − FEES
```

**Profit condition:** `|F| > |DELTA_PNL| + 2 × takerFeePct` — same skeleton as S1, but `DELTA_PNL` here is structurally the drop *up to the moment the credit is observed plus reaction time*: the strategy never exits before the event that coincides with the drop. Expectation: `E[DELTA_PNL] ≈ −(early portion of the drop)`. At taker 0.05% and threshold −0.4, the trade survives an average adverse move up to 0.30%; given full drops of ≈ 2×|F| = 0.8%, profitability depends on exiting inside the first ≈ 35–40% of the drop's depth. The backtest must report the realized `|DELTA_PNL| / |F|` ratio distribution; a median ≥ (|F| − fees)/|F| kills the strategy at that threshold.

## 5. Parameterization & schema parity

| Doc var | Backtest key | Live key | Unit | Proposed | Schema default | Notes |
|---|---|---|---|---|---|---|
| `F_threshold` | `negative_funding_threshold_percent` | `negativeFundingThresholdPercent` | percent, signed < 0 | **−0.4** | −0.4 | R10 |
| `entry_offset_seconds` | `entry_offset_seconds` | `entryOffsetSeconds` | seconds | **3** | 5 | bound ≥ 2 |
| `ws_timeout` | `funding_fee_timeout_seconds` | `fundingFeeTimeoutSeconds` | seconds | **10** (**OKX: 45**) | 30 | bound 5–120; OKX delta per `00_globals.md` §8 |
| — | `amount_usd` | `amountUsd` | USD | 10 | 20 | |
| — | `leverage` | `leverage` | int | 5 | 4 | |
| — | `ws_event_miss_rate` | *(backtest-only)* | fraction | **0.02** | 0.02 | timeout path must occur at rate > 0 |
| — | `ws_exit_extra_delay_seconds` | *(backtest-only)* | seconds | **2** | 2 | reaction margin on top of `T_drop` + latency |
| — | `taker_fee_pct` / `market_slippage_pct` / `order_latency_ms` | per `00_globals.md` §10.2 | | 0.05 / 0.05 / 1000 | | |

No schema-shape divergences. Note `fundingFeeTimeoutSeconds` is shared by S2 and S6 with different proposed values — it is a per-strategy key, not a global.

## 6. Backtest simulation rules

1. **Entry:** as S1 rule 1 (`01_strategy_1.md` §6.1). Funding accrual per §5.1 of globals.
2. **Event emulation:** localize `T_drop` per `00_globals.md` §3. With probability `1 − ws_event_miss_rate`: the exit decision occurs at `max(T_drop, T_settle) + ws_exit_extra_delay_seconds`, the fill lands one further candle later (`order_latency_ms`), and — binding — **no earlier than `drop_candle + 1`** (`00_globals.md` §5.5.2). Fill at that candle's bid proxy − slippage; `exit_reason = funding_fee_event`.
3. **Timeout path:** with probability `ws_event_miss_rate`, the gate never opens: exit decision at `T_settle + funding_fee_timeout_seconds`, fill + latency + slippage, `exit_reason = funding_fee_timeout`. This path **must** occur at a modeled rate > 0 — a backtest in which the timeout never fires is rejected.
4. **REST-poll path:** not modeled separately; it is dominated by the event path (same gate, similar timing) and by the timeout path on total miss. Treated as *bounded* by those two.
5. **`no_drop_localized` fallback:** `T_drop = T_settle + drop_search_window_seconds` (latest arming) — the exit happens at the conservative late edge.
6. **Same-candle rules:** exit never on `drop_candle`; entry/exit round-trip on one candle impossible by construction but structurally enforced.
7. **Feasibility:** as S1 rule 6.

### Parity ledger — Strategy 1 WS

| Live behavior | Backtest treatment |
|---|---|
| Exit gated on funding-fee event | **Modeled conservatively** — `T_drop` + extra delay + latency, never before `drop_candle + 1` (bias: later, worse exits) |
| WS event miss → timeout exit | **Modeled conservatively** — `ws_event_miss_rate = 0.02 > 0` (bias: occasional worst-path exits) |
| REST funding-fee poll (T+3 s, 8 s grace) | **Bounded** — sandwiched between event path and timeout path; not separately simulated (justification: its outcome always lies between the two modeled paths) |
| ±5 s event `fundingTime` matching | **Not modeled** — mismatched-event early exits assumed away; monitored live via gate telemetry (justification: modeling would require an event-error distribution we don't have; the error is two-sided) |
| WS order rejection → REST reduce-only fallback | **Not modeled** — bounded by slippage/latency conservatism |
| Market entry/exit fills | **Modeled conservatively** — touch + slippage + latency |
| Funding accrual | **Modeled faithfully** — fill-time test, settled rate |
| Predicted-rate selection | **Named optimism** — settled-rate proxy (`00_globals.md` §5.2) |
| Kill switch / sweeps / restart recovery | **Not modeled** — operational |
