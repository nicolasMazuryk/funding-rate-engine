# Funding-Rate Event Strategies — Shared Specification (GLOBALS)

**Audience:** the backtester implementation and the live-engine implementation. Both are built against this document set. One spec, two implementations.

---

## 0. File breakdown & include-by-reference convention

| File | Contents |
|---|---|
| `00_globals.md` (this file) | Event timeline, empirical drop model, `T_drop` localization, latency & fill model, same-candle rules, accrual/rate rules, sizing, safety mechanisms, engine order-path behavior, per-exchange deltas, global variable registry, hard parameter bounds, exit-reason & error-code registries, group common logic (§G-L, §G-S, §G-R, §G-D), strategy inventory. |
| `01_strategy_1.md` | S1 — Negative Funding LONG, timed exit. |
| `02_strategy_1_ws.md` | S1-WS — Negative Funding LONG, funding-fee-event exit. |
| `03_strategy_2.md` | S2 — Negative Funding LONG, trailing-retracement exit. |
| `04_strategy_3a.md` | S3a — Negative Funding SHORT, ride the drop. |
| `05_strategy_4_1a.md` | S4.1a — Post-funding LONG ladder. |
| `06_strategy_4_2a.md` | S4.2a — Post-funding LONG single limit. |
| `07_strategy_6.md` | S6 — Post-funding directional, WS-gated entry (not backtestable). |

**Convention.** Every strategy file *includes this file by reference*. A strategy file contains exactly six sections (Selection logic; Execution flow; Exit policy; P&L decomposition & profit condition; Parameterization & schema parity; Backtest simulation rules ending in a parity ledger) and states only **deltas** from the group common logic in §G-\* of this file. Cross-references are exact: e.g. "`00_globals.md` §3 (T_drop localization)". Nothing in a strategy file re-derives shared logic; nothing in this file is strategy-specific beyond the §G-\* group blocks.

**Supersession note.** Where this set contradicts the source extracts, this set wins. Every deliberate contradiction is called out inline in a box labeled **RECONCILIATION**. The major ones are indexed in §13.

---

## 1. Core hypothesis & notation

Perpetual-futures symbols with strongly negative predicted funding experience a sharp, fast price drop within seconds **after** the funding settlement. Long strategies harvest the funding payment and manage the drop as a cost; short and post-funding strategies harvest the drop itself. Strategy 6 generalizes to any sign/direction and bets on the post-settlement directional move.

### 1.1 Binding notation (used in every file)

| Symbol | Meaning | Convention |
|---|---|---|
| `T_settle` | Nominal settlement + position-snapshot instant, `HH:MM:00` on the exchange schedule. All scheduling offsets are relative to it. **A position accrues funding iff it is open at `T_settle`** (fill-time test, §5.1). | Known in advance. Legacy name `T_funding` maps 1:1 to `T_settle`. |
| `T_drop` | The instant funding actually accrues and the price reacts — one event, two observables (private WS `funding_fee` event; sharp price drop). Lags `T_settle` by 0–10 s, varying per event and exchange. | Live: WS event (±5 s `fundingTime` tolerance) or REST poll. Backtest: localized per §3. |
| `F` | Funding rate, **signed percent**. `F = −0.4` means −0.40% per settlement. `|F|` denotes its magnitude in percent. | **RECONCILIATION:** the source `_globals.md` defined `F` as a positive decimal with sign supplied by context. All formulas in this set are restated under signed-percent. Any source formula of the form `P × (1 − F × k)` becomes `P × (1 − |F| × k / 100)`. |
| `P_entry`, `P_exit`, `P_avg`, `P_low` | Entry fill price; exit fill price; fill-weighted average entry (ladders); **running** minimum since a stated arming time (never the final minimum unless explicitly the settled outcome). | prices |
| `NET_PNL` | `NET_PNL = DELTA_PNL + FUNDING_PNL − FEES`, all terms in percent of notional. | Long: `DELTA_PNL = (P_exit − P_entry)/P_entry × 100`. Short: negated. Negative funding: longs receive `FUNDING_PNL = +|F|`, shorts pay `FUNDING_PNL = −|F|`. |

### 1.2 Unit conventions (load-bearing — repeated on every parameter row)

- **percent** — `0.3` means 0.30% (30 bp). Used for all thresholds, TP/SL distances, fees, slippage.
- **fraction** — `0.5` means 50%. Used **only** for `retracementPct`. No other parameter is a fraction.
- **seconds** — integers unless suffixed `Ms`.
- **signed** vs **absolute** — stated per row. `negativeFundingThresholdPercent` is signed-negative; `fundingThresholdPercent` (S6) is signed-any.

A config value in the wrong unit is a **loader error**, not a warning (§11.2).

---

## 2. Event timeline & empirical drop model (binding on the backtester)

Two timestamps, one event. Never merge `T_settle` and `T_drop`; never assume the drop sits on the settlement candle.

Chart-validated facts of 1 s candles around negative-funding settlements, which the backtester must encode:

1. **Drop timing.** The sharp drop clusters in `[T_settle, T_settle + 10 s]` — sometimes the first second, sometimes 3–10 s later; occasionally selling begins one candle early. Hard-coding "drop = the `HH:MM:00` candle" mis-times every credit-gated action.
2. **Drop magnitude.** Typically a multiple of `|F|` (observed: `F = −0.33` producing ≈0.8% peak-to-trough within ~10 s), concentrated in 1–3 large red candles. Consequence: at small `|F|`, the drop is usually *larger* than the funding collected — see the profit-condition warnings in `01_strategy_1.md` §4.
3. **Recovery is a hypothesis, not a fact.** Observed post-drop paths: (a) fast V-retrace within 30–60 s; (b) partial retrace then chop; (c) **continued decline for minutes, low far below the initial drop**. Every recovery-dependent strategy (S2, S4.\*) must be survivable on path (c) via SL + deadline, and the backtest must price path (c) honestly.
4. **Initial-drop bottom ≠ session low.** The running low keeps making new lows well after the drop candle. All trailing logic is causal (running minimum), never the final minimum.

---

## 3. `T_drop` localization in the backtest — the one sanctioned lookahead

Historical data has no funding-fee event stream, so `T_drop` is identified from the price.

### 3.1 Algorithm (normative)

Within the search window `W = [T_settle, T_settle + dropSearchWindowSeconds]` (proposed **10 s**), over 1 s candles:

```
drop_move(c)  = (prev_close(c) − low(c)) / prev_close(c) × 100          # percent
red_range(c)  = (high(c) − low(c)) / open(c) × 100  if close(c) < open(c), else 0

candidate set = { c in W : drop_move(c) ≥ Q }
Q             = max( dropQualifierFundingMult × |F| ,
                     dropQualifierRangeMult   × R_pre )
R_pre         = median over [T_settle − 30 s, T_settle − 1 s] of (high − low)/open × 100

drop_candle   = argmax over candidate set of drop_move(c)
                (tie-break: larger red_range(c); further tie: earlier candle)
T_drop        = open timestamp of drop_candle

fallback      : if candidate set is empty → T_drop = T_settle + dropSearchWindowSeconds
                (latest, most conservative arming time; flag event as `no_drop_localized`)
```

| Parameter | Backtest key | Unit | Proposed | Bounds |
|---|---|---|---|---|
| `dropSearchWindowSeconds` | `drop_search_window_seconds` | seconds | **10** | [5, 30] |
| `dropQualifierFundingMult` | `drop_qualifier_funding_mult` | multiplier on `|F|` (percent-on-percent) | **0.5** | [0.1, 2.0] |
| `dropQualifierRangeMult` | `drop_qualifier_range_mult` | multiplier on `R_pre` | **3.0** | [1.5, 10] |

These three keys are backtest-only (no live counterpart — live observes the real event).

### 3.2 Scope restriction (normative)

This is **deliberate, bounded lookahead**, the only one permitted anywhere in the system, restricted to **event localization**:

- The backtester may look ahead within `W` **only to extract the timestamp** of `drop_candle`.
- No strategy logic may use the drop candle's prices, its magnitude, or the knowledge that a drop occurred to decide entries, set prices, or size positions. Entries and pre-placed orders are decided strictly on pre-`T_settle` information.
- All credit-gated actions (S1-WS exit, S2 tracker arming, S6 MAIN entry) are simulated at `T_drop`, never at `T_settle`.
- **Justification (binding text):** live, the engine reacts to the funding-fee event; the price drop is the historical shadow of that same event. Using the drop to *time* the simulation reproduces the live trigger; using it to *trade* would be clairvoyance.

---

## 4. Latency & fill model (backtest-binding)

| Element | Rule |
|---|---|
| Order placement latency | Live estimate 800 ms network + engine. Backtest injects `order_latency_ms = 1000` (**1 s**, i.e. one candle) between every decision and exchange receipt — entries, exits, cancels, re-places. |
| Market orders | Fill at the **touch** (best ask for buys, best bid for sells) **plus** adverse slippage `market_slippage_pct` (proposed **0.05**, percent). Filling at last trade or mid is disqualified — liquidity thins exactly when these strategies trade. |
| Limit orders | Fill only on **trade-through**: price strictly beyond the limit (`low < limit` for buys, `high > limit` for sells) on that candle. Touch-fills are disallowed — they inflate maker-fill rates and are a primary source of over-optimistic results. |
| Stop-market orders | Trigger when the stop price trades (candle range crosses it); fill as a market order with the market slippage model; taker fee. Gap-through: fill at the next available price ± slippage, never at the trigger level, when the path has moved through it. |
| Reduce-only | Reduce-only exits cannot open opposite exposure on a race; simulated qty capped at current position. |
| Throttles & staggers | Replicate live pacing where it changes outcomes: S2 TP re-place ≤ 1/s with 1 s price polling; per-exchange submission stagger (Bybit 150 ms, Binance 100 ms — in 1 s-candle simulation, multi-order placements become effective on the following candle). |
| Lot/notional feasibility | Exchange lot-step flooring and `minCost` checks on every simulated order; drop/skip exactly as live (§G-R for ladder rules). |

---

## 5. Rules derived from the timeline (binding on every strategy and the backtester)

### 5.1 Accrual rule
Funding P&L is credited/charged **iff the position is open at `T_settle`**, tested against the **fill time including injected latency**, not the decision time. An order *sent* before `HH:MM:00` but *filled* after it earns nothing — the canonical false-positive generator.

### 5.2 Rate rule (no lookahead)
Selection uses the **predicted** rate observable at decision time (`T_settle − entryOffsetSeconds`) live; the backtest uses the historical **settled** rate as its selection input (predicted-rate history is not archived — this is a **named optimism source**: predicted and settled rates can differ near the threshold; treat threshold sweeps as sensitivity analysis). Accrual always uses the **settled** rate.

### 5.3 Credit-gated actions occur at `T_drop`
Any live action gated on the `funding_fee` event happens, in simulation, at `T_drop`, never at `T_settle`. The seconds between them are exactly where the drop lives; arming a trailing TP at `T_settle` lets the simulated tracker see lows the live tracker never sees.

### 5.4 FIFO settlement caveat
On venues that attribute funding to position legs FIFO, a position opened before `T_settle` and reversed after it (S6's PRE_FUNDING + MAIN) has funding attributed to the pre-existing leg. Note: at `T_settle` only the PRE_FUNDING leg exists (MAIN fires after the event), so the *economic* charge lands on PRE_FUNDING on all six venues; the FIFO caveat governs *ledger attribution* after reversal. Per-exchange attribution table lives in `07_strategy_6.md` §2.

### 5.5 Same-candle resolution rules (intra-candle realism)
Within one 1 s candle the trade sequence is unknown; never resolve that ambiguity in the strategy's favor:

1. **No same-candle round trips (SL excepted).** An entry fill and any exit **other than the SL** (TP, retracement limit, timed, deadline) may not both execute on one candle. **Only the SL may exit on the entry-fill candle.** Non-SL exit evaluation starts at `entry_candle + 1`.
2. **No exits/actions on `drop_candle` for credit-gated logic.** Anything armed at `T_drop` (S1-WS exit, S2 TP tracking, S6 MAIN) executes **no earlier than `drop_candle + 1`** — the intra-candle sequence "funding event → order → fill" cannot be verified.
3. **SL-vs-TP conflicts resolve pessimistically.** If one candle's range spans both, assume **SL first** (taker exit at the stop, or worse gap-through price). Same principle for any pair of competing orders: choose the worse ordering.
4. **Entry-vs-protective-order conflicts resolve pessimistically.** If a limit entry and its SL level are both inside one candle's range, **both fire on that candle** and the outcome is the worst: entry filled, SL exits same candle at the stop (or worse gap-through with slippage).
5. **Gap-through fills** (repeated for emphasis): triggered stops and expired-deadline market exits fill at the next available price with slippage.

---

## 6. Sizing & account plumbing (uniform)

- Fixed notional per intent: `amountUsd` (`mainAmountUsd` on S6). `qty = amountUsd / price / contractSize`, floored to lot step. (Code ref: `src/execution/strategies/shared/sizing.ts`.)
- `leverage` is set via `setLeverage` before entry; failure is a **hard reject**. Leverage posts margin (`amountUsd / leverage`); it does **not** scale notional. The backtest models it only as a feasibility/margin check, never as a P&L multiplier.
- Fees parameterized per exchange: `takerFeePct` (proposed default **0.05**, percent, range 0.02–0.06) and `makerFeePct` (proposed default **0.02**, percent, range 0.00–0.02), applied per fill by the fee class of the order type that filled.
- `enabled: false` skips the strategy entirely.

---

## 7. Safety mechanisms (live; backtest treatment stated)

### 7.1 Kill switch
States `off | paused | flatten`. When `!= off`, `preflight()` rejects every new intent with `intent.error { code: 'kill_switch' }` before any exchange API call — engine-internal only, no exchange-side activity. `flatten` additionally runs `flattenAll()` (reduce-only market closes across all exchanges). Code ref: `src/execution/execution/preflight.ts:32`. **Backtest:** not modeled (operational, not strategic); listed in every parity ledger as *not modeled — operational*.

### 7.2 Post-exit order sweep (`sweepReduceOnlyOrders`)
After every intent exit the engine cancels lingering reduce-only orders for that symbol (async, after the exit transition). `sl_tp_deadline`-family strategies always produce ≥ 1 post-exit cancel; these cancels are expected, not pathological. Code ref: `src/execution/execution/manager.ts`. **Backtest:** modeled implicitly — all sibling orders are removed at exit settle; no double fills permitted.

### 7.3 Orphan handling
Orphan-position auto-flatten and a stale reduce-only sweep before entry clean up crash/desync state. **Backtest:** not modeled — no crashes in simulation; listed per parity ledger.

---

## 8. Live-engine order path & per-exchange deltas

- **WS-mandatory strategies:** `strategy_1_ws`, `strategy_2`, `strategy_6` place orders over the WS order adapter and **throw at startup** if none is available. **OKX and only OKX** falls back to REST on `WS_TIMEOUT`.
- **Submission stagger:** serialized per exchange — Bybit 150 ms, Binance 100 ms (other venues: 100 ms default until measured).
- **Rate-limit reservation:** 10% of each exchange's rate budget reserved for order submit/cancel.
- **REST fill-poll:** on a missed WS fill, poll `getOrder` (10 s timeout, ≤ 15 polls), circuit-open on consecutive errors.
- **REST funding-fee poll:** for WS-gated strategies, fires at `T_settle + 3 s` with an 8 s grace period; observing the credit opens the funding gate before/without the WS event.
- **Funding-fee event matching tolerance:** ±5 s between event `fundingTime` and expected `T_settle`.
- **Per-exchange config deltas (carried from source):** OKX `fundingFeeTimeoutSeconds` = 45 (vs 10 elsewhere); OKX `leverage` = 4 on strategy_1 (5 elsewhere).
- **Backtest treatment:** stagger and latency per §4; funding-gate = `T_drop` per §3/§5.3; WS-miss modeled via `ws_event_miss_rate` (strategy files); REST fill-poll not modeled (bounded by the miss-rate path).

---

## 9. Engine-level guards (replicated at selection level in the backtest)

Scheduler pre-filter, applied before any strategy evaluates:

1. Evaluate only symbols whose predicted funding is within **0.1 pp** of an enabled strategy's threshold.
2. Skip funding snapshots **older than 60 s** (data-freshness gate — a stale snapshot means no trigger, not a trigger on stale data).
3. Order candidates **most-negative-first** (most-extreme-first for S6 positive thresholds).

Backtest: identical filter on the historical rate series; snapshot staleness modeled as: if no rate observation within 60 s before decision time → skip the event.

---

## 10. Global variable & parameter registry

### 10.1 Input variables (per funding event)

| Variable | Type | Source |
|---|---|---|
| `funding_rate_predicted` | float, signed percent | Exchange API (live); **settled rate proxy in backtest** (§5.2) |
| `funding_rate_settled` | float, signed percent | Exchange API / history |
| `T_settle` | datetime | Exchange funding schedule (1h/2h/4h/8h; intervals can change dynamically — schedule must be re-read per event, never assumed constant per symbol) |
| `price_timeseries` | 1 s OHLCV, ≥ `[T_settle − 60 s, T_settle + max(deadline) + 60 s]` | Market data store |
| `taker_fee_pct`, `maker_fee_pct` | float, percent | Exchange fee schedule |
| `lot_step`, `min_cost`, `contract_size` | exchange metadata | Exchange API |

### 10.2 Cross-strategy tunables (bridge table)

Backtest schema = flat snake_case; live schema = camelCase under a `strategies:` list in `live-configs/strategies/<strategy>-<exchange>.yaml`. **Both schemas are generated from one source of truth** (§11.2). Full per-strategy rows (with proposed values) live in each strategy file §5; this table fixes names, units, and schema defaults.

| Doc variable | Backtest key | Live key | Unit | Signed? | Schema default | Used in |
|---|---|---|---|---|---|---|
| `F_threshold` | `negative_funding_threshold_percent` | `negativeFundingThresholdPercent` | percent | signed, must be < 0 | **−0.4** | 1, 1WS, 2, 3a, 4.1a, 4.2a |
| `F_threshold_s6` | `funding_threshold_percent` | `fundingThresholdPercent` (**legacy engine key `funding_threshold` — migration alias required; see §13-R6**) | percent | signed, any | 0 (always-on) | 6 |
| `entry_offset_seconds` | `entry_offset_seconds` | `entryOffsetSeconds` | seconds | — | 5 | all |
| `exit_offset_seconds` | `exit_offset_seconds` | `exitOffsetSeconds` | seconds | — | **6** (see §13-R2) | 1 |
| `ws_timeout` | `funding_fee_timeout_seconds` | `fundingFeeTimeoutSeconds` | seconds | — | 30 | 1WS, 2, 6 |
| `retracement_pct` | `retracement_pct` | `retracementPct` | **fraction [0,1]** | — | 0.5 | 2 |
| `SL_fixed` | `stop_loss_percent` | `stopLossPercent` | percent (fixed, **not** funding-scaled) | abs | 1.0 | 3a |
| `TP_pct` | `take_profit_pct` | `takeProfitPct` | **percent** (0.3 = 30 bp) — highest unit-mismatch risk in the system; loader guard §11.2 | abs | 0.2 | 4.1a, 4.2a |
| `TP_mult_3a` | `tp_variant_a_multiplier` | `tpVariantAMultiplier` | multiplier on `|F|` | abs | 1.5 | 3a |
| `TP_mult_6` | `tp_multiplier` | `tpMultiplier` | multiplier on `|F|` | abs | 0.5 | 6 |
| `sl_mult` | `sl_multiplier` | `slMultiplier` | multiplier on `|F|` | abs | 1.0 | 2, 4.1a, 4.2a, 6 |
| `ladder_count` | `ladder_count` | `ladderCount` | integer | — | 5 | 4.1a |
| `ladder_top_mult` | `ladder_top_mult` | `ladderTopMult` | multiplier on `|F|` | abs | 0.5 | 4.1a |
| `ladder_bottom_mult` | `ladder_bottom_mult` | `ladderBottomMult` | multiplier on `|F|` | abs | 1.5 | 4.1a |
| `limit_offset_mult` | `limit_offset_mult` | `limitOffsetMult` | multiplier on `|F|` | abs | 0.75 | 4.2a |
| `T_deadline` | `deadline_seconds` | `deadlineSeconds` | seconds | — | per strategy | 2, 3a, 4.x, 6 |
| `main_side` | `main_side` | `mainSide` | enum `long|short` | — | *(required)* | 6 |
| — | `amount_usd` | `amountUsd` (`mainAmountUsd` on 6) | USD | — | 20 (6: required) | all |
| — | `leverage` | `leverage` | integer | — | 4 | all |
| — | `taker_fee_pct` / `maker_fee_pct` | *(exchange profile, not strategy YAML)* | percent | abs | 0.05 / 0.02 | all |
| — | `market_slippage_pct` | *(backtest-only)* | percent | abs | 0.05 | all backtests |
| — | `order_latency_ms` | *(backtest-only)* | ms | — | 1000 | all backtests |
| — | `ws_event_miss_rate` | *(backtest-only)* | fraction [0,1] | — | 0.02 | 1WS, 2 backtests |
| — | `ws_exit_extra_delay_seconds` | *(backtest-only)* | seconds | — | 2 | 1WS backtest |
| — | `drop_search_window_seconds` / `drop_qualifier_funding_mult` / `drop_qualifier_range_mult` | *(backtest-only)* | §3.1 | — | 10 / 0.5 / 3.0 | all backtests |

### 10.3 Output variables (per trade)

`P_entry`, `P_exit`, `P_avg` (ladders), `delta_pnl` (%), `funding_pnl` (%), `fee_cost` (%), `net_pnl` (%), `exit_reason` (§12.1), `error_code` (§12.2, when no position resulted), `hold_duration_s`, `fill_count` (ladders), `funding_received` (bool, per §5.1), `t_drop_offset_s` (backtest: `T_drop − T_settle`; `null` if `no_drop_localized`).

---

## 11. Hard parameter bounds & config validation

### 11.1 Bounds (enforced by both loaders; violations fail the run)

| Key | Bound | Note |
|---|---|---|
| `entry_offset_seconds` | ≥ 2 | must exceed order latency |
| `exit_offset_seconds` | **> 5** (i.e. ≥ 6) | **RECONCILIATION §13-R2** — source bound was ≥ 2 and live ran 4; superseded |
| `deadline_seconds` | **10 ≤ v ≤ 3600** | **RECONCILIATION §13-R3** — source bound 2–180 contradicted source live values 900/1800/1800; superseded |
| `funding_fee_timeout_seconds` | 5 ≤ v ≤ 120 | |
| `ladder_count` | 2 ≤ v ≤ 20 | |
| `ladder_bottom_mult` | > `ladder_top_mult` | else ladder inverted |
| `sl_multiplier` (S2, S4.1a) | 0.5 ≤ v ≤ 4.0 | |
| `sl_multiplier` (S4.2a) | 1.0 ≤ v ≤ 4.0 **and** > `limit_offset_mult` | else the stop sits above the entry limit |
| `sl_multiplier` (S6) | 0.5 ≤ v ≤ 4.0 | |
| `retracement_pct` | 0 < v ≤ 1.0 | fraction |
| `take_profit_pct` | 0.05 ≤ v ≤ 5.0 (percent) | **unit guard** — see §11.2 |
| `negative_funding_threshold_percent` | −5.0 ≤ v < 0 | signed |
| `funding_threshold_percent` (S6) | −5.0 ≤ v ≤ 5.0 | signed; 0 = always-on |
| `stop_loss_percent` | 0.2 ≤ v ≤ 5.0 (percent) | |
| S3a co-run guard | loader rejects `strategy_3a` enabled alongside any LONG strategy (1, 1WS, 2, 4.\*a); S6 exempt (configurable direction) | one strategy per container |

### 11.2 Unit-mismatch protection (normative)

The classic defect: a take-profit written as a decimal fraction but read as percent — `0.003` becoming 0.3 bp instead of 30 bp, silently shrinking the TP 100×. Protections, all mandatory:

1. **Single source of truth.** Backtest (snake_case) and live (camelCase) schemas are **generated from one canonical schema file**; hand-writing one side is prohibited. A config valid in one schema but not the other is rejected, never coerced.
2. **Unit column on every parameter row** in every strategy file — no exceptions.
3. **Loader range guards** double as unit guards: `take_profit_pct < 0.05` → hard error `unit_suspect_fraction` ("value looks like a fraction; percent expected"). This catches the source extract's live value `takeProfitPct = 0.003` (§13-R4).
4. **Round-trip test in CI:** every canonical parameter is emitted to both schemas, re-parsed, and compared numerically.

---

## 12. Terminal-state registries

### 12.1 `exit_reason` enum (position existed and was closed)

| Value | Meaning | Strategies |
|---|---|---|
| `timed` | Fixed-offset market exit | 1 |
| `funding_fee_event` | Exit fired on WS/REST-observed funding credit | 1WS |
| `funding_fee_timeout` | Exit fired on the timeout fallback | 1WS |
| `tp_hit` | Take-profit limit filled (maker) | 2, 3a, 4.1a, 4.2a, 6 |
| `sl_hit` | Stop-market triggered (taker) | 2, 3a, 4.1a, 4.2a, 6 |
| `deadline` | Deadline market close (taker) | 2, 3a, 4.1a, 4.2a, 6 |
| `kill_switch_flatten` | Flattened by kill switch | any (live only) |

### 12.2 `error_code` enum (intent terminated without a managed position)

| Value | Meaning | Strategies |
|---|---|---|
| `kill_switch` | Rejected in preflight | any |
| `limit_expired` | Entry limit never filled by deadline; cancelled; no position | 4.2a (**§13-R5** — undocumented code-only outcome in source, now normative) |
| `ladder_no_fills` | No rung filled by deadline; ladder cancelled | 4.1a |
| `pre_funding_order_failed` / `pre_funding_order_rejected` / `pre_funding_not_filled` / `funding_event_timeout` / `main_order_failed` / `main_order_rejected` / `close_pre_funding_failed` | S6 entry state machine — see `07_strategy_6.md` §3 | 6 |

A backtest run must emit these same enums so live and simulated distributions are directly comparable.

---

## §G — Group common logic

### §G-L — Pre-settlement LONG: funding collection (S1, S1-WS, S2)

- **Selection (common):** at `T_settle − entryOffsetSeconds`: predicted funding `F ≤ negativeFundingThresholdPercent` (signed percent; proposed **−0.4**), engine guards (§9) pass, `market.status == 'trading'`.
- **Entry (common):** BUY MARKET at best ask (+ slippage in backtest). The **fill**, including injected latency, must land **before `T_settle`** or the funding leg is zero (§5.1). Backtest checks fill-time-vs-settlement, not decision time. With `entry_offset_seconds = 3` and 1 s latency, the simulated fill lands ≈ `T_settle − 2 s`.
- **P&L skeleton:** `FUNDING_PNL = +|F|` (longs receive on negative funding, iff §5.1 passes); `DELTA_PNL` = drop suffered entry→exit (typically negative); profit condition `|F| > |DELTA_PNL| + FEES`.
- **Backtest parity (common):** entry latency injected; funding per §5.1; credit-gated logic keyed to `T_drop` (§3, §5.3); recovery never assumed (§2.3).
- **Threshold economics (binding remark):** with round-trip taker fees ≈ 0.10% and an empirical drop that is a *multiple* of `|F|`, a threshold of −0.1 leaves the funding leg barely covering fees before any delta cost. Proposed −0.4 is the Group-L starting point; the source extracts' live value −0.1 is carried as a sweep point, not as the proposal.

### §G-S — Pre-settlement SHORT: ride the drop (S3a)

- Same selection family as §G-L; direction SHORT flips the funding leg: `FUNDING_PNL = −|F|` (shorts pay, iff open at `T_settle` per §5.1). Profit condition `DELTA_PNL > |F| + FEES`.
- Entry SELL MARKET at `T_settle − entryOffsetSeconds`; immediate OCO (fixed-percent SL stop-market above, funding-scaled TP limit below); deadline market close. Full spec: `04_strategy_3a.md`.

### §G-R — Post-settlement recovery: limit entries, no funding (S4.1a, S4.2a)

- **Thesis:** buy the drop with resting limits placed at `T_settle − entryOffsetSeconds`, priced below the pre-event reference by funding-scaled offsets; intended to fill after `T_settle` during the drop. **For all 4.\* strategies `FUNDING_PNL = 0` unconditionally, regardless of when any limit fills.** The edge is pure delta recovery — empirically **not guaranteed** (§2.3); continued-decline paths must be survivable via SL + deadline and priced honestly.
- **No pre-settlement-fill exception:** a rung/limit filling **before** `T_settle` is logged (`ladder.pre_funding_fill` + ops event) and the position is **kept**, but it accrues **no funding in the model** — the backtest applies blanket `FUNDING_PNL = 0` for 4.\*; there is no per-fill accrual check. **RECONCILIATION §13-R7:** the source `strategy_4_1.md` claimed a pre-settlement fill *does* accrue funding; superseded — economically the exchange may credit it, but the specification books it as 0 (conservative: discards a small windfall, never invents one).
- **Exit skeleton:** SL (funding-scaled below average fill), TP limit above average fill, deadline market close, unfilled-limit expiry (`limit_expired` / `ladder_no_fills`).
- **Backtest parity (common):** per-rung trade-through fills; **no rung's TP may act on the candle that rung filled** (the SL may, resolving pessimistically per §5.5); where several rungs fill inside `drop_candle`, non-SL protective orders act from `drop_candle + 1` at that candle's prices; largest-remainder quantity distribution across rungs; min-notional rung drops; whole-symbol skip on top-rung `minCost` failure; expiry cancellation; cancel/fill-race protective reduce-only close.

### §G-D — Event-gated directional (S6)

- **Not a negative-funding strategy.** Selection supports all four sign/direction combinations; the bet is the post-settlement directional move. Do not import §G-L framing. Full spec: `07_strategy_6.md`. Not backtestable — substitute validation protocol defined there.

---

## §Inventory — Strategy inventory

| Strategy | Group | Direction | Funding leg | Entry | Exit policy kind | Backtestable | Validation path |
|---|---|---|---|---|---|---|---|
| 1 | L | LONG | receives `+|F|` | market, pre-settle | `timed` | **Yes** | backtest §`01` |
| 1 WS | L | LONG | receives `+|F|` | market, pre-settle | `funding_fee_event` | **Yes** (via `T_drop` emulation) | backtest §`02` |
| 2 | L | LONG | receives `+|F|` | market, pre-settle | `sl_tp_deadline_retracement_funding_event` | **Yes** (causal tracker emulation) | backtest §`03` |
| 3a | S | SHORT | pays `−|F|` | market, pre-settle | `sl_tp_deadline` | **Yes** | backtest §`04` |
| 4.1a | R | LONG | none (0) | ladder limits, pre-placed | `sl_tp_deadline` | **Yes** (per-rung fills) | backtest §`05` |
| 4.2a | R | LONG | none (0) | single limit, pre-placed | `sl_tp_deadline` | **Yes** | backtest §`06` |
| 6 | D | configurable | PRE leg pays | tiny opposite pre-fund + MAIN on WS event | `sl_tp_deadline_post_funding_event` | **No** | shadow/canary protocol, `07_strategy_6.md` §6 |

---

## 13. Reconciliation index (source-extract divergences resolved by this set)

| ID | What the source said | What this spec says | Why |
|---|---|---|---|
| **R1 — notation** | `T_funding`; `F` positive decimal with sign from context | `T_settle`/`T_drop`; `F` signed percent | Two-timestamp model is load-bearing; signed percent removes a whole class of sign bugs. All formulas restated. |
| **R2 — S1 exit offset** | live 4 s; bound ≥ 2 | bound **> 5 s**; proposed **6 s**, identical in live and backtest; exit **not** re-keyed to `T_drop` | Framework mandate. A fixed offset sometimes exits before the drop (favorable) and sometimes after/inside it (unfavorable) — that variance is the strategy; the bound keeps the exit decision clear of the settlement boundary. Note: this changes S1's economics vs the 4 s live history; re-validate by backtest. |
| **R3 — deadline bound** | loader bound 2–180 s, but live values 900/1800/1800 s | bound 10–3600 s | Source bound and source live values were mutually contradictory; live values are the operative intent. |
| **R4 — `takeProfitPct` unit** | schema default 0.2 (percent) but live value `0.003` ⚠️ | percent everywhere; loader guard rejects v < 0.05 as `unit_suspect_fraction` | `0.003` is almost certainly a fraction (0.3%) mis-entered into a percent field → an effective 0.3 bp TP, below one maker fee. Highest-risk key in the system. |
| **R5 — `limit_expired`** | code-only, undocumented outcome | normative `error_code` (§12.2), specified in `06_strategy_4_2a.md` | Undocumented terminal states are parity holes. |
| **R6 — S6 threshold key** | live key `funding_threshold` (snake_case outlier in a camelCase schema) | canonical live key `fundingThresholdPercent`; engine must accept legacy alias `funding_threshold` for one migration cycle, warn on use | Schema-shape inconsistency is exactly the defect class §11.2 exists to kill. |
| **R7 — 4.1a pre-settlement fill funding** | "the position does accrue funding" | booked as `FUNDING_PNL = 0` unconditionally for 4.\* | Framework mandate; conservative direction (§14). |
| **R8 — S2 anchor/TP framing** | original spec's one-shot Fibonacci limit `[0.3, 0.618]`; "resolved" note describes trailing tracker | trailing tracker is normative; `retracementPct` proposed 1.0 with deadline-frequency requirement (`03_strategy_2.md` §3) | One-shot limit at the final low is double lookahead; rejected. |
| **R9 — S1-WS/S2 timeout values** | mixed 10/30/45 across files | per-strategy proposed values on each file's §5 table; OKX=45 preserved as an exchange delta | Consolidation. |
| **R10 — Group-L threshold** | live −0.1 everywhere | proposed −0.4 (schema default −0.4); −0.1 retained as sweep point | §G-L threshold economics. |
| **R11 — 4.1a SL/TP lifecycle** | SL+TP both placed only after `T_settle` once unfilled rungs are cancelled | SL placed **with the ladder at placement time** (price precomputable from known rung prices/qtys); TP placed on first rung fill and re-placed on each deeper fill; unfilled rungs cancelled **only at exit/deadline** | Framework mandate; see `05_strategy_4_1a.md` §2 for the full lifecycle and its consequences. |
| **R12 — exit-reason vocabulary** | 4-value enum (`TP_HIT`, `SL_HIT`, `DEADLINE`, `MARKET_EXIT`) | full registry §12.1/§12.2 | `MARKET_EXIT` was ambiguous (timed? deadline? flatten?); every path now has exactly one enum value. |

---

## 14. Conservatism direction (binding)

Wherever the backtest must simplify, the simplification must **hurt** the simulated strategy. Active global conservatisms and their bias direction:

| Simplification | Bias |
|---|---|
| Trade-through-only limit fills | fewer/never-better maker fills → understates TP hit rate |
| 1 s injected latency on every action (live ≈ 0.8 s), except LIMIT orders | worse entries/exits |
| `T_drop` fallback = latest window edge on non-localization | latest possible arming → tracker sees fewer lows, S1-WS exits latest |
| SL-first / worst-ordering conflict resolution | worst fill of any ambiguous candle |
| `ws_event_miss_rate > 0` (timeout paths must occur) | occasional worst-path exits that live rarely takes |
| Slippage on every market/stop fill, fixed configurable %, default 0.04% | direct cost |
| `FUNDING_PNL = 0` for all 4.\* fills incl. pre-settlement | discards a possible windfall |
| Settled rate as selection proxy (§5.2) | **the one named optimism** — flagged, bounded by threshold-sensitivity sweeps, not correctable from available data |

Backtest reports must list which conservatisms were active and, where measurable (latency, slippage, miss rate), their estimated P&L bias.
