# Strategy 1 WS — Negative Funding LONG, Funding-Fee-Event Exit

**Document:** `02_strategy_1_ws.md` · includes `00_globals.md` by reference · group common logic: `00_globals.md` §G-L
**Exit policy kind:** `funding_fee_event`

**Conclusion first.** Same funding-collection bet as S1, but the exit is gated on confirmation that funding actually accrued — the private WS `funding_fee` event (with REST-poll safety net and timeout fallback). This trades S1's fixed-clock variance for event-timing risk: the exit fires at `T_drop + reaction`, which by construction is **at or after** the drop begins. Timing risk concentrates in the gap between funding credit and exit fill — the strategy holds *through* the start of the drop by design, so its `DELTA_PNL` is systematically worse than a lucky S1 exit and better than an unlucky one.

---

## 1. Selection logic

Identical to S1 — `00_globals.md` §G-L, no deltas. (Same threshold key, same guards.)

## 2. Execution flow

| # | Time (rel.) | Action | Order / event | Price formula | Expiry/cancel |
|---|---|---|---|---|---|
| 1 | `T_settle − entryOffsetSeconds` | decide entry | BUY MARKET via **WS order adapter** (mandatory; engine throws at startup without one; OKX-only REST fallback on `WS_TIMEOUT`) | best ask | — |
| 2 | after `T_settle` | await `ws.funding_fee` for (exchange, symbol) with `fundingTime` within ±5 s of `T_settle` | event | — | — |
| 2b | `T_settle + 3 s` | REST funding-fee poll fires, 8 s grace; observing the credit opens the funding gate exactly as the WS event would (`00_globals.md` §6) | REST | — | — |
| 3 | on gate open (WS or REST) | EXIT | SELL MARKET **reduce-only** at best bid (WS adapter) | bid | — |
| 4 | `T_settle + fundingFeeTimeoutSeconds`, if gate never opened | EXIT (fallback) | SELL MARKET reduce-only | bid | — |
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
FUNDING_PNL = +|F|                      # iff entry fill < T_settle (00_globals.md §3.1)
FEES        = takerFeePct × 2
NET_PNL     = DELTA_PNL + FUNDING_PNL − FEES
```

**Profit condition:** `|F| > |DELTA_PNL| + 2 × takerFeePct` — same skeleton as S1, but `DELTA_PNL` here is structurally the drop *up to the moment the credit is observed plus reaction time*: the strategy never exits before the event that coincides with the drop. Expectation: `E[DELTA_PNL] ≈ −(early portion of the drop)`. At taker 0.05% and threshold −0.4, the trade survives an average adverse move up to 0.30%; given full drops of ≈ 2×|F| = 0.8%, profitability depends on exiting inside the first ≈ 35–40% of the drop's depth. Live trade data must be monitored for the realized `|DELTA_PNL| / |F|` ratio distribution; a median ≥ (|F| − fees)/|F| kills the strategy at that threshold.

## 5. Parameterization & schema

| Doc var | Live key | Unit | Proposed | Schema default | Notes |
|---|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | percent, signed < 0 | **−0.4** | −0.4 | R10 |
| `entry_offset_seconds` | `entryOffsetSeconds` | seconds | **3** | 5 | bound ≥ 2 |
| `ws_timeout` | `fundingFeeTimeoutSeconds` | seconds | **10** (**OKX: 45**) | 30 | bound 5–120; OKX delta per `00_globals.md` §6 |
| — | `amountUsd` | USD | 10 | 20 | |
| — | `leverage` | int | 5 | 4 | |
| — | `taker_fee_pct` per `00_globals.md` §8.2 | percent | 0.05 | | |

Note `fundingFeeTimeoutSeconds` is shared by S2 and S6 with different proposed values — it is a per-strategy key, not a global.
