# Funding-Rate Event Strategies — Shared Specification (GLOBALS)

**Audience:** the live-engine implementation. This document set is the single spec for the live system.

---

## 0. File breakdown & include-by-reference convention

| File | Contents |
|---|---|
| `00_globals.md` (this file) | Event timeline, empirical drop model, accrual/rate rules, sizing, safety mechanisms, engine order-path behavior, per-exchange deltas, global variable registry, hard parameter bounds, exit-reason & error-code registries, group common logic (§G-L, §G-S, §G-R, §G-D), strategy inventory. |
| `01_strategy_1.md` | S1 — Negative Funding LONG, timed exit. |
| `02_strategy_1_ws.md` | S1-WS — Negative Funding LONG, funding-fee-event exit. |
| `03_strategy_2.md` | S2 — Negative Funding LONG, trailing-retracement exit. |
| `04_strategy_3a.md` | S3a — Negative Funding SHORT, ride the drop. |
| `05_strategy_4_1a.md` | S4.1a — Post-funding LONG ladder. |
| `06_strategy_4_2a.md` | S4.2a — Post-funding LONG single limit. |
| `07_strategy_6.md` | S6 — Post-funding directional, WS-gated entry. |

**Convention.** Every strategy file *includes this file by reference*. A strategy file contains exactly five sections (Selection logic; Execution flow; Exit policy; P&L decomposition & profit condition; Parameterization & schema) and states only **deltas** from the group common logic in §G-\* of this file. Cross-references are exact: e.g. "`00_globals.md` §2 (event timeline & empirical drop model)". Nothing in a strategy file re-derives shared logic; nothing in this file is strategy-specific beyond the §G-\* group blocks.

**Supersession note.** Where this set contradicts the source extracts, this set wins. Every deliberate contradiction is called out inline in a box labeled **RECONCILIATION**. The major ones are indexed in §11.

---

## 1. Core hypothesis & notation

Perpetual-futures symbols with strongly negative predicted funding experience a sharp, fast price drop within seconds **after** the funding settlement. Long strategies harvest the funding payment and manage the drop as a cost; short and post-funding strategies harvest the drop itself. Strategy 6 generalizes to any sign/direction and bets on the post-settlement directional move.

### 1.1 Binding notation (used in every file)

| Symbol | Meaning | Convention |
|---|---|---|
| `T_settle` | Nominal settlement + position-snapshot instant, `HH:MM:00` on the exchange schedule. All scheduling offsets are relative to it. **A position accrues funding iff it is open at `T_settle`** (fill-time test, §3.1). | Known in advance. Legacy name `T_funding` maps 1:1 to `T_settle`. |
| `T_drop` | The instant funding actually accrues and the price reacts — one event, two observables (private WS `funding_fee` event; sharp price drop). Lags `T_settle` by 0–10 s, varying per event and exchange. | Observed live via the WS `funding_fee` event (±5 s `fundingTime` tolerance) or, on a miss, a REST poll. |
| `F` | Funding rate, **signed percent**. `F = −0.4` means −0.40% per settlement. `|F|` denotes its magnitude in percent. | **RECONCILIATION:** the source `_globals.md` defined `F` as a positive decimal with sign supplied by context. All formulas in this set are restated under signed-percent. Any source formula of the form `P × (1 − F × k)` becomes `P × (1 − |F| × k / 100)`. |
| `P_entry`, `P_exit`, `P_avg`, `P_low` | Entry fill price; exit fill price; fill-weighted average entry (ladders); **running** minimum since a stated arming time (never the final minimum unless explicitly the settled outcome). | prices |
| `NET_PNL` | `NET_PNL = DELTA_PNL + FUNDING_PNL − FEES`, all terms in percent of notional. | Long: `DELTA_PNL = (P_exit − P_entry)/P_entry × 100`. Short: negated. Negative funding: longs receive `FUNDING_PNL = +|F|`, shorts pay `FUNDING_PNL = −|F|`. |

### 1.2 Unit conventions (load-bearing — repeated on every parameter row)

- **percent** — `0.3` means 0.30% (30 bp). Used for all thresholds, TP/SL distances, fees, slippage.
- **fraction** — `0.5` means 50%. Used **only** for `retracementPct`. No other parameter is a fraction.
- **seconds** — integers unless suffixed `Ms`.
- **signed** vs **absolute** — stated per row. `negativeFundingThresholdPercent` is signed-negative; `fundingThresholdPercent` (S6) is signed-any.

A config value in the wrong unit is a **loader error**, not a warning (§9.2).

---

## 2. Event timeline & empirical drop model (binding on every strategy's risk design)

Two timestamps, one event. Never merge `T_settle` and `T_drop`; never assume the drop sits on the settlement candle.

Chart-validated facts of 1 s candles around negative-funding settlements, which every strategy's risk parameters (SL, deadline, TP) must account for:

1. **Drop timing.** The sharp drop clusters in `[T_settle, T_settle + 10 s]` — sometimes the first second, sometimes 3–10 s later; occasionally selling begins one candle early. Hard-coding "drop = the `HH:MM:00` candle" mis-times every credit-gated action.
2. **Drop magnitude.** Typically a multiple of `|F|` (observed: `F = −0.33` producing ≈0.8% peak-to-trough within ~10 s), concentrated in 1–3 large red candles. Consequence: at small `|F|`, the drop is usually *larger* than the funding collected — see the profit-condition warnings in `01_strategy_1.md` §4.
3. **Recovery is a hypothesis, not a fact.** Observed post-drop paths: (a) fast V-retrace within 30–60 s; (b) partial retrace then chop; (c) **continued decline for minutes, low far below the initial drop**. Every recovery-dependent strategy (S2, S4.\*) must be survivable on path (c) via SL + deadline.
4. **Initial-drop bottom ≠ session low.** The running low keeps making new lows well after the drop candle. All trailing logic is causal (running minimum), never the final minimum.

---

## 3. Rules derived from the timeline (binding on every strategy)

### 3.1 Accrual rule
Funding P&L is credited/charged **iff the position is open at `T_settle`**, tested against the **actual fill time**, not the decision time. An order *sent* before `HH:MM:00` but *filled* after it earns nothing — the canonical false-positive generator.

### 3.2 Rate rule
Selection uses the **predicted** rate observable at decision time (`T_settle − entryOffsetSeconds`). Accrual uses the **settled** rate, read from the exchange after settlement.

### 3.3 FIFO settlement caveat
On venues that attribute funding to position legs FIFO, a position opened before `T_settle` and reversed after it (S6's PRE_FUNDING + MAIN) has funding attributed to the pre-existing leg. Note: at `T_settle` only the PRE_FUNDING leg exists (MAIN fires after the event), so the *economic* charge lands on PRE_FUNDING on all six venues; the FIFO caveat governs *ledger attribution* after reversal. Per-exchange attribution table lives in `07_strategy_6.md` §2.

---

## 4. Sizing & account plumbing (uniform)

- Fixed notional per intent: `amountUsd` (`mainAmountUsd` on S6). `qty = amountUsd / price / contractSize`, floored to lot step. (Code ref: `src/execution/strategies/shared/sizing.ts`.)
- `leverage` is set via `setLeverage` before entry; failure is a **hard reject**. Leverage posts margin (`amountUsd / leverage`); it does **not** scale notional.
- Fees parameterized per exchange: `takerFeePct` (proposed default **0.05**, percent, range 0.02–0.06) and `makerFeePct` (proposed default **0.02**, percent, range 0.00–0.02), applied per fill by the fee class of the order type that filled.
- `enabled: false` skips the strategy entirely.

---

## 5. Safety mechanisms (live)

### 5.1 Kill switch
States `off | paused | flatten`. When `!= off`, `preflight()` rejects every new intent with `intent.error { code: 'kill_switch' }` before any exchange API call — engine-internal only, no exchange-side activity. `flatten` additionally runs `flattenAll()` (reduce-only market closes across all exchanges). Code ref: `src/execution/execution/preflight.ts:32`.

### 5.2 Post-exit order sweep (`sweepReduceOnlyOrders`)
After every intent exit the engine cancels lingering reduce-only orders for that symbol (async, after the exit transition). `sl_tp_deadline`-family strategies always produce ≥ 1 post-exit cancel; these cancels are expected, not pathological. Code ref: `src/execution/execution/manager.ts`.

### 5.3 Orphan handling
Orphan-position auto-flatten and a stale reduce-only sweep before entry clean up crash/desync state.

---

## 6. Live-engine order path & per-exchange deltas

- **Order placement latency:** live estimate 800 ms network + engine, budgeted into every offset calculation.
- **WS-mandatory strategies:** `strategy_1_ws`, `strategy_2`, `strategy_6` place orders over the WS order adapter and **throw at startup** if none is available. REST fallback on `WS_TIMEOUT` is a per-exchange config flag (`ws_order_rest_fallback` in the exchange profile, `09` §4).
- **Submission stagger:** serialized per exchange — Bybit 150 ms, Binance 100 ms (other venues: 100 ms default until measured).
- **Rate-limit reservation:** 10% of each exchange's rate budget reserved for order submit/cancel.
- **REST fill-poll:** on a missed WS fill, poll `getOrder` (10 s timeout, ≤ 15 polls), circuit-open on consecutive errors.
- **REST funding-fee poll:** for WS-gated strategies, fires at `T_settle + 3 s` with an 8 s grace period; observing the credit opens the funding gate before/without the WS event.
- **Funding-fee event matching tolerance:** ±5 s between event `fundingTime` and expected `T_settle`.
- **Per-exchange config deltas (carried from source):** any exchange profile may override `fundingFeeTimeoutSeconds`, `leverage`, or `ws_order_rest_fallback` from the strategy-level default.

---

## 7. Engine-level guards

Scheduler pre-filter, applied before any strategy evaluates:

1. Evaluate only symbols whose predicted funding is within **0.1 pp** of an enabled strategy's threshold.
2. Skip funding snapshots **older than 60 s** (data-freshness gate — a stale snapshot means no trigger, not a trigger on stale data).
3. Order candidates **most-negative-first** (most-extreme-first for S6 positive thresholds).

---

## 8. Global variable & parameter registry

### 8.1 Input variables (per funding event)

| Variable | Type | Source |
|---|---|---|
| `funding_rate_predicted` | float, signed percent | Exchange API |
| `funding_rate_settled` | float, signed percent | Exchange API / history |
| `T_settle` | datetime | Exchange funding schedule (1h/2h/4h/8h; intervals can change dynamically — schedule must be re-read per event, never assumed constant per symbol) |
| `price_timeseries` | 1 s OHLCV, ≥ `[T_settle − 60 s, T_settle + max(deadline) + 60 s]` | Market data store |
| `taker_fee_pct`, `maker_fee_pct` | float, percent | Exchange fee schedule |
| `lot_step`, `min_cost`, `contract_size` | exchange metadata | Exchange API |

### 8.2 Cross-strategy tunables (bridge table)

Live schema = camelCase under a `strategies:` list in `live-configs/strategies/<strategy>-<exchange>.yaml`, generated from one canonical schema file (§9.2). Full per-strategy rows (with proposed values) live in each strategy file §5; this table fixes names, units, and schema defaults.

| Doc variable | Live key | Unit | Signed? | Schema default | Used in |
|---|---|---|---|---|---|
| `F_threshold` | `negativeFundingThresholdPercent` | percent | signed, must be < 0 | **−0.4** | 1, 1WS, 2, 3a, 4.1a, 4.2a |
| `F_threshold_s6` | `fundingThresholdPercent` (**legacy engine key `funding_threshold` — migration alias required; see §11-R6**) | percent | signed, any | 0 (always-on) | 6 |
| `entry_offset_seconds` | `entryOffsetSeconds` | seconds | — | 5 | all |
| `exit_offset_seconds` | `exitOffsetSeconds` | seconds | — | **6** (see §11-R2) | 1 |
| `ws_timeout` | `fundingFeeTimeoutSeconds` | seconds | — | 30 | 1WS, 2, 6 |
| `retracement_pct` | `retracementPct` | **fraction [0,1]** | — | 0.5 | 2 |
| `SL_fixed` | `stopLossPercent` | percent (fixed, **not** funding-scaled) | abs | 1.0 | 3a |
| `TP_pct` | `takeProfitPct` | **percent** (0.3 = 30 bp) — highest unit-mismatch risk in the system; loader guard §9.2 | abs | 0.2 | 4.1a, 4.2a |
| `TP_mult_3a` | `tpVariantAMultiplier` | multiplier on `|F|` | abs | 1.5 | 3a |
| `TP_mult_6` | `tpMultiplier` | multiplier on `|F|` | abs | 0.5 | 6 |
| `sl_mult` | `slMultiplier` | multiplier on `|F|` | abs | 1.0 | 2, 4.1a, 4.2a, 6 |
| `ladder_count` | `ladderCount` | integer | — | 5 | 4.1a |
| `ladder_top_mult` | `ladderTopMult` | multiplier on `|F|` | abs | 0.5 | 4.1a |
| `ladder_bottom_mult` | `ladderBottomMult` | multiplier on `|F|` | abs | 1.5 | 4.1a |
| `limit_offset_mult` | `limitOffsetMult` | multiplier on `|F|` | abs | 0.75 | 4.2a |
| `T_deadline` | `deadlineSeconds` | seconds | — | per strategy | 2, 3a, 4.x, 6 |
| `main_side` | `mainSide` | enum `long|short` | — | *(required)* | 6 |
| — | `amountUsd` (`mainAmountUsd` on 6) | USD | — | 20 (6: required) | all |
| — | `leverage` | integer | — | 4 | all |
| — | *(exchange profile, not strategy YAML)* | percent | abs | 0.05 / 0.02 | all |

### 8.3 Output variables (per trade)

`P_entry`, `P_exit`, `P_avg` (ladders), `delta_pnl` (%), `funding_pnl` (%), `fee_cost` (%), `net_pnl` (%), `exit_reason` (§10.1), `error_code` (§10.2, when no position resulted), `hold_duration_s`, `fill_count` (ladders), `funding_received` (bool, per §3.1), `t_drop_offset_s` (`T_drop − T_settle`, from the observed funding-fee event/price reaction; `null` if `T_drop` was never observed for the event).

---

## 9. Hard parameter bounds & config validation

### 9.1 Bounds (enforced by the loader; violations fail the run)

| Key | Bound | Note |
|---|---|---|
| `entry_offset_seconds` | ≥ 2 | must exceed order latency |
| `exit_offset_seconds` | **> 5** (i.e. ≥ 6) | **RECONCILIATION §11-R2** — source bound was ≥ 2 and live ran 4; superseded |
| `deadline_seconds` | **10 ≤ v ≤ 3600** | **RECONCILIATION §11-R3** — source bound 2–180 contradicted source live values 900/1800/1800; superseded |
| `funding_fee_timeout_seconds` | 5 ≤ v ≤ 120 | |
| `ladder_count` | 2 ≤ v ≤ 20 | |
| `ladder_bottom_mult` | > `ladder_top_mult` | else ladder inverted |
| `sl_multiplier` (S2, S4.1a) | 0.5 ≤ v ≤ 4.0 | |
| `sl_multiplier` (S4.2a) | 1.0 ≤ v ≤ 4.0 **and** > `limit_offset_mult` | else the stop sits above the entry limit |
| `sl_multiplier` (S6) | 0.5 ≤ v ≤ 4.0 | |
| `retracement_pct` | 0 < v ≤ 1.0 | fraction |
| `take_profit_pct` | 0.05 ≤ v ≤ 5.0 (percent) | **unit guard** — see §9.2 |
| `negative_funding_threshold_percent` | −5.0 ≤ v < 0 | signed |
| `funding_threshold_percent` (S6) | −5.0 ≤ v ≤ 5.0 | signed; 0 = always-on |
| `stop_loss_percent` | 0.2 ≤ v ≤ 5.0 (percent) | |
| S3a co-run guard | loader rejects `strategy_3a` enabled alongside any LONG strategy (1, 1WS, 2, 4.\*a); S6 exempt (configurable direction) | one strategy per container |

### 9.2 Unit-mismatch protection (normative)

The classic defect: a take-profit written as a decimal fraction but read as percent — `0.003` becoming 0.3 bp instead of 30 bp, silently shrinking the TP 100×. Protections, all mandatory:

1. **Single source of truth.** The live camelCase schema is **generated from one canonical schema file**; hand-writing it is prohibited.
2. **Unit column on every parameter row** in every strategy file — no exceptions.
3. **Loader range guards** double as unit guards: `take_profit_pct < 0.05` → hard error `unit_suspect_fraction` ("value looks like a fraction; percent expected"). This catches the source extract's live value `takeProfitPct = 0.003` (§11-R4).
4. **Round-trip test in CI:** every canonical parameter is emitted to the live schema, re-parsed, and compared numerically against its source value.

---

## 10. Terminal-state registries

### 10.1 `exit_reason` enum (position existed and was closed)

| Value | Meaning | Strategies |
|---|---|---|
| `timed` | Fixed-offset market exit | 1 |
| `funding_fee_event` | Exit fired on WS/REST-observed funding credit | 1WS |
| `funding_fee_timeout` | Exit fired on the timeout fallback | 1WS |
| `tp_hit` | Take-profit limit filled (maker) | 2, 3a, 4.1a, 4.2a, 6 |
| `sl_hit` | Stop-market triggered (taker) | 2, 3a, 4.1a, 4.2a, 6 |
| `deadline` | Deadline market close (taker) | 2, 3a, 4.1a, 4.2a, 6 |
| `kill_switch_flatten` | Flattened by kill switch | any |

### 10.2 `error_code` enum (intent terminated without a managed position)

| Value | Meaning | Strategies |
|---|---|---|
| `kill_switch` | Rejected in preflight | any |
| `limit_expired` | Entry limit never filled by deadline; cancelled; no position | 4.2a (**§11-R5** — undocumented code-only outcome in source, now normative) |
| `ladder_no_fills` | No rung filled by deadline; ladder cancelled | 4.1a |
| `pre_funding_order_failed` / `pre_funding_order_rejected` / `pre_funding_not_filled` / `funding_event_timeout` / `main_order_failed` / `main_order_rejected` / `close_pre_funding_failed` | S6 entry state machine — see `07_strategy_6.md` §3 | 6 |

---

## §G — Group common logic

### §G-L — Pre-settlement LONG: funding collection (S1, S1-WS, S2)

- **Selection (common):** at `T_settle − entryOffsetSeconds`: predicted funding `F ≤ negativeFundingThresholdPercent` (signed percent; proposed **−0.4**), engine guards (§7) pass, `market.status == 'trading'`.
- **Entry (common):** BUY MARKET at best ask. The **fill** must land **before `T_settle`** or the funding leg is zero (§3.1). With `entry_offset_seconds = 3` and ≈800 ms latency, the fill lands ≈ `T_settle − 2 s`.
- **P&L skeleton:** `FUNDING_PNL = +|F|` (longs receive on negative funding, iff §3.1 passes); `DELTA_PNL` = drop suffered entry→exit (typically negative); profit condition `|F| > |DELTA_PNL| + FEES`.
- **Threshold economics (binding remark):** with round-trip taker fees ≈ 0.10% and an empirical drop that is a *multiple* of `|F|`, a threshold of −0.1 leaves the funding leg barely covering fees before any delta cost. Proposed −0.4 is the Group-L starting point; the source extracts' live value −0.1 is carried as a sweep point, not as the proposal.

### §G-S — Pre-settlement SHORT: ride the drop (S3a)

- Same selection family as §G-L; direction SHORT flips the funding leg: `FUNDING_PNL = −|F|` (shorts pay, iff open at `T_settle` per §3.1). Profit condition `DELTA_PNL > |F| + FEES`.
- Entry SELL MARKET at `T_settle − entryOffsetSeconds`; immediate OCO (fixed-percent SL stop-market above, funding-scaled TP limit below); deadline market close. Full spec: `04_strategy_3a.md`.

### §G-R — Post-settlement recovery: limit entries, funding rarely accrued (S4.1a, S4.2a)

- **Thesis:** buy the drop with resting limits placed at `T_settle − entryOffsetSeconds`, priced below the pre-event reference by funding-scaled offsets; intended to fill after `T_settle` during the drop. Because most fills land after `T_settle`, `FUNDING_PNL` is usually **0** under the standard accrual rule (§3.1) — but that is a consequence of *when* the rung fills, not a strategy-wide constant. The edge is primarily delta recovery — empirically **not guaranteed** (§2.3); continued-decline paths must be survivable via SL + deadline.
- **Pre-settlement fills accrue real funding — pulled from the exchange, never assumed.** A rung/limit filling **before** `T_settle` is logged (`ladder.pre_funding_fill` + ops event), the position is **kept**, and it is tested against §3.1 exactly like every other strategy: if open at `T_settle`, it accrues. The engine never derives the amount from `|F|`; it reads the **actual settled amount from the exchange** (`FundingFeeAccrued` event / `fundingHistory` REST, `11` §9) and books whatever the venue actually credited or charged. **RECONCILIATION §11-R7:** `FUNDING_PNL` for 4.\* is exchange-sourced actual accrual, applied per §3.1 like any other strategy — never a hardcoded constant in either direction.
- **Exit skeleton:** SL (funding-scaled below average fill), TP limit above average fill, deadline market close, unfilled-limit expiry (`limit_expired` / `ladder_no_fills`).

### §G-D — Event-gated directional (S6)

- **Not a negative-funding strategy.** Selection supports all four sign/direction combinations; the bet is the post-settlement directional move. Do not import §G-L framing. Full spec: `07_strategy_6.md`. Validated via the **shadow → canary protocol** defined there (`07_strategy_6.md` §6).

---

## §Inventory — Strategy inventory

| Strategy | Group | Direction | Funding leg | Entry | Exit policy kind | Spec |
|---|---|---|---|---|---|---|
| 1 | L | LONG | receives `+|F|` | market, pre-settle | `timed` | `01_strategy_1.md` |
| 1 WS | L | LONG | receives `+|F|` | market, pre-settle | `funding_fee_event` | `02_strategy_1_ws.md` |
| 2 | L | LONG | receives `+|F|` | market, pre-settle | `sl_tp_deadline_retracement_funding_event` | `03_strategy_2.md` |
| 3a | S | SHORT | pays `−|F|` | market, pre-settle | `sl_tp_deadline` | `04_strategy_3a.md` |
| 4.1a | R | LONG | exchange-sourced actual (usually 0) | ladder limits, pre-placed | `sl_tp_deadline` | `05_strategy_4_1a.md` |
| 4.2a | R | LONG | exchange-sourced actual (usually 0) | single limit, pre-placed | `sl_tp_deadline` | `06_strategy_4_2a.md` |
| 6 | D | configurable | PRE leg pays | tiny opposite pre-fund + MAIN on WS event | `sl_tp_deadline_post_funding_event` | shadow/canary protocol, `07_strategy_6.md` §6 |

---

## 11. Reconciliation index (source-extract divergences resolved by this set)

| ID | What the source said | What this spec says | Why |
|---|---|---|---|
| **R1 — notation** | `T_funding`; `F` positive decimal with sign from context | `T_settle`/`T_drop`; `F` signed percent | Two-timestamp model is load-bearing; signed percent removes a whole class of sign bugs. All formulas restated. |
| **R2 — S1 exit offset** | live 4 s; bound ≥ 2 | bound **> 5 s**; proposed **6 s**; exit **not** re-keyed to `T_drop` | Framework mandate. A fixed offset sometimes exits before the drop (favorable) and sometimes after/inside it (unfavorable) — that variance is the strategy; the bound keeps the exit decision clear of the settlement boundary. Note: this changes S1's economics vs the 4 s live history; re-validate against live data. |
| **R3 — deadline bound** | loader bound 2–180 s, but live values 900/1800/1800 s | bound 10–3600 s | Source bound and source live values were mutually contradictory; live values are the operative intent. |
| **R4 — `takeProfitPct` unit** | schema default 0.2 (percent) but live value `0.003` ⚠️ | percent everywhere; loader guard rejects v < 0.05 as `unit_suspect_fraction` | `0.003` is almost certainly a fraction (0.3%) mis-entered into a percent field → an effective 0.3 bp TP, below one maker fee. Highest-risk key in the system. |
| **R5 — `limit_expired`** | code-only, undocumented outcome | normative `error_code` (§10.2), specified in `06_strategy_4_2a.md` | Undocumented terminal states are coverage gaps. |
| **R6 — S6 threshold key** | live key `funding_threshold` (snake_case outlier in a camelCase schema) | canonical live key `fundingThresholdPercent`; engine must accept legacy alias `funding_threshold` for one migration cycle, warn on use | Schema-shape inconsistency is exactly the defect class §9.2 exists to kill. |
| **R7 — 4.1a pre-settlement fill funding** | "the position does accrue funding" | `FUNDING_PNL` for 4.\* is pulled from actual exchange-reported accrual (§3.1 accrual rule, same as every strategy) — not hardcoded to 0 and not derived from `|F|` | Hardcoding to 0 silently discarded real, exchange-confirmed funding on pre-settlement fills; the exchange is the source of truth. |
| **R8 — S2 anchor/TP framing** | original spec's one-shot Fibonacci limit `[0.3, 0.618]`; "resolved" note describes trailing tracker | trailing tracker is normative; `retracementPct` proposed 1.0 with deadline-frequency requirement (`03_strategy_2.md` §3) | One-shot limit at the final low is double lookahead; rejected. |
| **R9 — S1-WS/S2 timeout values** | mixed 10/30/45 across files | per-strategy proposed values on each file's §5 table; any venue-specific value (e.g. 45 s) is an ordinary exchange-profile delta, not tied to one named exchange | Consolidation. |
| **R10 — Group-L threshold** | live −0.1 everywhere | proposed −0.4 (schema default −0.4); −0.1 retained as sweep point | §G-L threshold economics. |
| **R11 — 4.1a SL/TP lifecycle** | SL+TP both placed only after `T_settle` once unfilled rungs are cancelled | SL placed **with the ladder at placement time** (price precomputable from known rung prices/qtys); TP placed on first rung fill and re-placed on each deeper fill; unfilled rungs cancelled **only at exit/deadline** | Framework mandate; see `05_strategy_4_1a.md` §2 for the full lifecycle and its consequences. |
| **R12 — exit-reason vocabulary** | 4-value enum (`TP_HIT`, `SL_HIT`, `DEADLINE`, `MARKET_EXIT`) | full registry §10.1/§10.2 | `MARKET_EXIT` was ambiguous (timed? deadline? flatten?); every path now has exactly one enum value. |
