# Strategy 6 — Post-Funding Directional, WS-Gated Entry

**Document:** `07_strategy_6.md` · includes `00_globals.md` by reference · group common logic: `00_globals.md` §G-D
**Exit policy kind:** `sl_tp_deadline_post_funding_event` · **Backtestable:** **NO** — mechanism in §6, substitute validation protocol in §6.2

**Conclusion first.** S6 is not a negative-funding strategy — do not import the §G-L framing. It bets on the **directional move after settlement**, in whichever direction `mainSide` says, for whichever funding-sign regime `fundingThresholdPercent` selects (all four sign/direction combinations are legal; the proposed config is LONG on funding ≥ +0.1). A minimal opposite-direction PRE_FUNDING market order exists **only** to subscribe the symbol to the private user-data stream; the MAIN order fires on the WS `funding_fee` event and reverses to the net directional position. It cannot be backtested: the entry is causally gated on a private event that only fires because the tiny position exists, and MAIN's fill price sits inside the very drop/spike candle whose intra-second sequence the same-candle rules (`00_globals.md` §5.5.2) forbid resolving. Even with `T_drop` localization, simulating MAIN at `drop_candle + 1` prices would assert an execution quality that cannot be verified. Validation is therefore live-empirical (shadow → canary), per §6.2.

---

## 1. Selection logic

```
AT T_settle − entryOffsetSeconds:
  IF ( fundingThresholdPercent > 0 AND F_predicted ≥ fundingThresholdPercent )      # proposed: F ≥ +0.1
  OR ( fundingThresholdPercent < 0 AND F_predicted ≤ fundingThresholdPercent )
  OR ( fundingThresholdPercent == 0 )                                                # always-on
  AND market.status == 'trading'
  AND scheduler guards pass (00_globals.md §9 — pre-filter is most-extreme-first for positive thresholds)
  AND preFundingQty < mainQty            # sizing guard: else reversing leaves no net position — skip
  THEN trigger intent
```

`mainSide` and the threshold sign are independent. The sizing guard (`preFundingQty`, the minimum lot/min-notional quantity, must be strictly less than `mainQty`) is re-checked **at submission time against a fresh price**.

## 2. Execution flow (LONG example; SHORT mirrors all signs)

```
1. AT T_settle − entryOffsetSeconds:
   → PRE_FUNDING_ORDER: SELL MARKET (opposite to mainSide),
     size preFundingVolume = min feasible qty (max of lot step and minNotional qty; derived, not configurable)
     Purpose: opens a tiny position that subscribes the symbol to the private WS user-data stream.

2. AWAIT ws.funding_fee for (exchange, symbol), fundingTime within ±5 s of T_settle.
   HARD FALLBACK at T_settle + fundingFeeTimeoutSeconds:
   → abort: MARKET-close PRE_FUNDING (reduce-only, size = preFundingVolume),
     retried up to 3× with 250 / 1000 / 3000 ms backoff;
     a REST getPositions() fetch is ground truth for what actually needs closing.
   → terminate error_code = funding_event_timeout.

3. ON ws.funding_fee:
   → CONFIRM the PRE_FUNDING order actually filled (else abort + close, error_code = pre_funding_not_filled)
   → MAIN: BUY MARKET (mainSide), size = mainVolume, via WS order adapter.
     mainEventLock guarantees MAIN fires exactly once (once-only lock).
   → Net exchange position after fill = mainVolume − preFundingVolume, direction mainSide.

4. ON MAIN fill at P_entry:
   → CONFIRM net qty via REST getPositions() — normative (formerly divergence
     GETPOSITIONS_POST_MAIN_FILL, now spec):
       REST succeeds → exitQty = pos.qty
       REST fails    → warn 'strategy6: position fetch failed, falling back to tracked fills';
                       exitQty = tracked fills (mainVolume − preFundingVolume)
     Cost: ~100–300 ms extra latency (Binance FAPI); acceptable — SL/TP placement
     window is not tightly bound. Future option: cache position from WS ACCOUNT_UPDATE.
   → TP: SELL LIMIT       at P_entry × (1 + |F| × tpMultiplier / 100)
   → SL: SELL STOP-MARKET at P_entry × (1 − |F| × slMultiplier / 100)
     (SHORT mirrors: TP below, SL above.)
     tpPct/slPct are computed at FILL time from the settled |F|, not at decision time.
     TP/SL sized on exitQty (net).
   → Arm deadline at T_settle + deadlineSeconds.

5. EXIT (first of): TP fill → cancel SL, exit_reason = tp_hit
                    SL trigger → cancel TP, exit_reason = sl_hit
                    Deadline → cancel both, MARKET-close net, exit_reason = deadline
   Post-exit sweep per 00_globals.md §7.2.
```

**Funding attribution.** At `T_settle` the only open position is PRE_FUNDING (wrong direction) → it accrues the funding **cost** on all six venues; MAIN, filled after the event, accrues none this cycle. The FIFO caveat (`00_globals.md` §5.4) governs ledger attribution after the reversal:

| Exchange | Attribution of the settlement to legs after reversal | Confidence |
|---|---|---|
| Binance, Bybit, OKX, Gate.io, KuCoin, Bitget | Economic charge lands on the pre-existing (PRE_FUNDING) leg; per-venue ledger labeling **to be confirmed from venue docs/income statements during the canary phase** — the spec's conservative default books the full charge to `FUNDING_PRE` | default-conservative |

## 3. Exit policy & terminal states

**Kind:** `sl_tp_deadline_post_funding_event`. Exit paths as step 5 above (TP maker, SL taker, deadline taker).

**Error-code taxonomy (entry state machine — the most elaborate in the fleet):**

| `error_code` | Meaning | Position outcome |
|---|---|---|
| `pre_funding_order_failed` | PRE_FUNDING submission threw | none |
| `pre_funding_order_rejected` | exchange rejected PRE_FUNDING | none |
| `pre_funding_not_filled` | WS event arrived but PRE_FUNDING never filled — MAIN not sent | none (abort close if partial) |
| `funding_event_timeout` | no `ws.funding_fee` within timeout; PRE_FUNDING closed at small loss | flattened |
| `main_order_failed` / `main_order_rejected` | MAIN submission threw / rejected | PRE_FUNDING flattened via abort ladder |
| `close_pre_funding_failed` | abort could not flatten PRE_FUNDING after all 3 retries | **orphan risk** — ops alert; orphan auto-flatten (`00_globals.md` §7.3) is the backstop |

## 4. P&L decomposition & profit condition

```
PRE_FUNDING_DELTA = −(P_main_entry − P_pre_fill) × preFundingVolume / notional × 100   # tiny opposing delta
FUNDING_PRE       = −|funding charged on PRE_FUNDING at T_settle|                       # always a cost (wrong direction)
MAIN_DELTA        = (P_exit − P_entry) / P_entry × 100  on net qty (mainVolume − preFundingVolume)  # sign per mainSide
FEES              = takerFeePct × 2 (PRE_FUNDING entry + MAIN entry)
                  + takerFeePct (PRE_FUNDING abort/reversal leg is inside MAIN)
                  + [makerFeePct if tp_hit else takerFeePct] (exit)
NET_PNL           = MAIN_DELTA + PRE_FUNDING_DELTA + FUNDING_PRE − FEES
```

**Profit condition:** `MAIN_DELTA > |PRE_FUNDING_DELTA| + |FUNDING_PRE| + FEES`. `FUNDING_PRE` is minimized by construction (smallest feasible PRE_FUNDING size); with `mainAmountUsd = 10` and a min-notional PRE leg of ~5 USD on many venues, the PRE overhead is *not* negligible relative to notional — the spec flags that S6's economics improve directly with `mainAmountUsd`, and the canary protocol (§6.2) must measure realized PRE overhead in bp of net notional. MAIN, filled after the event, receives no funding this cycle.

**Key risks (binding list):** WS event miss (→ timeout, small PRE loss); PRE_FUNDING funding cost; MAIN slippage into thin post-event liquidity (MAIN is a market order fired into the spike); once-only lock failure would double-fire MAIN (lock is therefore normative, not advisory); `close_pre_funding_failed` orphan.

## 5. Parameterization & schema parity

| Doc var | Backtest key | Live key | Unit | Proposed | Schema default | Notes |
|---|---|---|---|---|---|---|
| `main_side` | `main_side` | `mainSide` | enum `long|short` | **long** | *(required)* | |
| `F_threshold_s6` | `funding_threshold_percent` | `fundingThresholdPercent` — **legacy engine key `funding_threshold` accepted as alias for one migration cycle, warn on use (R6)** | percent, **signed** (any sign; 0 = always-on) | **+0.1** | 0 | independent of `mainSide` |
| `entry_offset_seconds` | `entry_offset_seconds` | `entryOffsetSeconds` | seconds | **3** | 10 | PRE_FUNDING placement |
| `ws_timeout` | `funding_fee_timeout_seconds` | `fundingFeeTimeoutSeconds` | seconds | **10** (**OKX: 45**) | 30 | abort trigger |
| `TP_mult_6` | `tp_multiplier` | `tpMultiplier` | multiplier on `|F|` | **1.5** | 0.5 | computed at MAIN fill from settled rate |
| `sl_mult` | `sl_multiplier` | `slMultiplier` | multiplier on `|F|` | **1.5** | 1.0 | bound 0.5–4.0 |
| `T_deadline` | `deadline_seconds` | `deadlineSeconds` | seconds | **1800** | 3300 | bound 10–3600 (R3; note 3300 ≤ 3600 ✓) |
| — | `main_amount_usd` | `mainAmountUsd` | USD | **10** | *(required)* | see PRE-overhead remark §4 |
| — | `leverage` | `leverage` | int | **5** | *(required)* | |
| — | *(derived)* | `preFundingVolume` | qty | min lot / min-notional qty | *(not configurable)* | derived at trigger and re-checked at submission |

Backtest keys are listed for schema completeness (single source of truth, `00_globals.md` §11.2) even though no backtest consumes them — the canonical schema still validates S6 configs.

## 6. Backtest simulation rules

### 6.1 Not backtestable — mechanism

Two independent blockers, either sufficient:

1. **Causal gating on a private event.** The MAIN entry fires on `ws.funding_fee`, an event that arrives only because the PRE_FUNDING position exists on the private stream. Historical data contains neither the stream nor a per-account event-latency distribution; `T_drop` localization recovers the *market* shadow of settlement, not the *account-level* event timing that gates MAIN.
2. **Fill inside the forbidden candle.** MAIN is a market order fired into `drop_candle` (or the spike candle for positive-funding events). `00_globals.md` §5.5.2 forbids resolving the intra-candle sequence "event → order → fill"; simulating MAIN at `drop_candle + 1` prices would assert an execution quality (post-spike fill) that live does not have, and any intra-candle price assumption is unverifiable in both directions.

No conservative treatment exists that is both honest and informative — a simulation pessimistic enough to be safe (worst price of `drop_candle`) is uninformative about the real edge. Therefore: **not backtested at all**, per `00_globals.md` §Inventory.

### 6.2 Substitute validation protocol (normative)

1. **Shadow phase (≥ 2 weeks, all venues):** run the full state machine with order submission stubbed at the adapter (log-only). Measures: event arrival rate and `T_event − T_settle` latency distribution per venue; would-be MAIN decision timestamps; selection frequency at the configured threshold.
2. **Canary phase (≥ 4 weeks):** live with minimum sizing (`mainAmountUsd` at min feasible, one symbol cohort per venue). Acceptance metrics, each with a pre-registered threshold before scale-up: (a) `funding_event_timeout` rate ≤ 2×the shadow-phase miss estimate; (b) MAIN slippage distribution vs the `market_slippage_pct` assumption (p90 ≤ 2× assumed); (c) realized PRE overhead (`|PRE_FUNDING_DELTA| + |FUNDING_PRE| + PRE fees`) in bp of net notional; (d) funding-attribution audit per venue against income statements (fills the §2 table); (e) zero `close_pre_funding_failed` occurrences, else halt.
3. **Ongoing:** every S6 trade logs the full event timeline (`T_settle`, event receive time, MAIN send/fill times, drop-candle stats post hoc) so the live dataset itself becomes the calibration set for any future simulation attempt.

### Parity ledger — Strategy 6

| Behavior | Treatment |
|---|---|
| Entire entry path (PRE_FUNDING, WS event gate, MAIN) | **Not backtestable** — §6.1; substitute protocol §6.2 |
| TP/SL/deadline exit management | **Not backtested** (no simulated entry to manage); state machine validated in shadow/canary |
| REST `getPositions()` net-qty confirm | **Normative live behavior** (formerly `GETPOSITIONS_POST_MAIN_FILL` divergence, now spec §2.4) |
| Abort ladder (3 retries, backoff, REST ground truth) | Validated in canary; `close_pre_funding_failed` is a halt condition |
| Funding attribution per venue | Default-conservative booking to `FUNDING_PRE`; audited in canary (§6.2.d) |
| Kill switch / sweeps | Operational, as fleet-wide |
