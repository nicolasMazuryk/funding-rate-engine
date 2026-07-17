# Strategy Runtime & Intent Lifecycle

**Document:** `12_strategy_runtime_and_intent_lifecycle.md` · includes `00_globals.md` by reference · strategy behavior owned by `01`–`07`
**Covers:** the scheduler (HH:58 workflow), opportunity finding, preflight, cost model, sizing wiring, the entry→monitor→exit orchestration, and the **intent finite-state machine** with its failure modes.

**Conclusion first.** This is the **pure core** (`08` §3). It consumes the event stream, runs the enabled strategy module (`01`–`07`) through a uniform pipeline — *scan → select → preflight → intent → execute → monitor → exit* — and emits intents/commands. It contains **no strategy math** (that's in the strategy files) and **no I/O** (that's adapters/execution). It is deterministic given `(events, config)`.

---

## 1. Scheduler (the HH:58 workflow)

The engine is driven by timers, not polling loops (`08` §2, principle 3).

| Timer | Fires | Action |
|---|---|---|
| **Scan** | every hour at **`HH:58:00`** (2 min before the top of the hour) | run opportunity finding (§2) to shortlist candidates that will settle at `~HH:00:00` |
| **Entry** | per candidate at `T_settle − entryOffsetSeconds` | build & submit the intent (§3–§4) |
| **Exit / deadline** | per intent, per strategy exit policy | fire exit (`00_globals.md` §10.1) |

- `T_settle` and the funding **interval** (1/2/4/8 h) are **re-read per event** from the funding schedule — never assumed constant (`00_globals.md` §8.1). The `HH:58` scan covers the next top-of-hour settlement; symbols on longer intervals only appear when their settlement is imminent.
- The scan is one pass over the filtered perp-USDT universe (`10` §3); it is cheap and side-effect-free.

---

## 2. Opportunity finding (selection)

Applies the **engine-level guards** (`00_globals.md` §7) before any strategy-specific selection:

1. Evaluate only symbols whose **predicted** funding is within **0.1 pp** of the enabled strategy's threshold.
2. Skip funding snapshots **older than 60 s** (freshness gate — stale = no trigger).
3. Order candidates **most-negative-first** (most-extreme-first for S6 positive thresholds).

Then the strategy's own selection logic (`01`–`07` §1) decides the final trigger — e.g. `F_predicted ≤ negativeFundingThresholdPercent` (Group L/S/R) or the signed-any S6 rule. The runtime dispatches to the module via the strategy **registry** (`08` §5); it does not branch on strategy name.

**Selection input = predicted rate** at decision time (`00_globals.md` §3.2).

---

## 3. Preflight (fail-fast gate before any order)

Runs at entry time, before the first exchange write. Any failure terminates the intent with the appropriate `error_code` and **no** venue side effect.

| Check | Rule | On fail |
|---|---|---|
| Kill switch | state must be `off` (`00_globals.md` §5.1) | `error_code = kill_switch` |
| Risk gate | concurrency, notional, daily-loss, breaker open (`13`) | reject intent |
| Balance | free margin ≥ `amountUsd / leverage` (`BalanceUpdate`, `11` §7) | reject / `InsufficientBalance` |
| Precision & min-limits | price tick, lot step, min-notional, min-qty (`11` §3) | reject / `ContractLimits` |
| Account setup | leverage/margin/position-mode applied (`11` §1) | hard reject |
| Market status | `market.status == 'trading'` (`00_globals.md` §G-*) | skip |

Preflight is the single choke point where "should this trade exist?" is answered — kept in one place (DRY) so every strategy inherits identical safety.

---

## 4. Cost model (economic gate)

Before committing, the runtime evaluates the strategy's **profit condition** (each strategy §4) with live cost inputs, so uneconomic intents are dropped early:

```
NET_PNL = DELTA_PNL + FUNDING_PNL − FEES        # 00_globals §1.1
FEES    = per-fill fee class (taker/maker) from the exchange profile (09 §4)
```

- Fees, slippage assumptions, and thresholds come from config/venue profile; the model uses the **same formulas** as the strategy files (referenced, not re-derived) — e.g. Group L needs `|F| > |DELTA_PNL| + FEES`, S3a needs `DELTA_PNL > |F| + FEES`, S6 needs `MAIN_DELTA > |PRE_FUNDING_DELTA| + |FUNDING_PRE| + FEES`.
- The cost model is advisory at selection (it cannot know the realized drop) but **binding** on structurally-uneconomic configs (e.g. a threshold whose funding leg can't cover fees is rejected at load, `00_globals.md` §11-R10).

---

## 5. Intent finite-state machine

One intent = one strategy attempt on one symbol for one settlement. The intent FSM uses the shared FSM engine (`08` §5) and composes the order FSM (`11` §6). Every transition is WAL-persisted before its side effect (`14`).

```
                preflight ok            entry filled              exit fires
SELECTED ───────────────▶ SUBMITTING_ENTRY ───▶ MONITORING ─────────────▶ EXITING ───▶ CLOSED
   │                          │                     │                                    (exit_reason)
   │ preflight fail           │ entry fail/reject   │ deadline / SL / TP / funding-gate
   ▼                          ▼                     │
ABORTED                   ENTRY_FAILED              └─(no fill / expiry)─▶ NO_POSITION
(error_code)              (error_code)                                    (error_code)
```

| State | Meaning | Strategy relevance |
|---|---|---|
| `SELECTED` | passed guards + strategy selection (§2) | all |
| `SUBMITTING_ENTRY` | entry order(s) in flight (order FSM, `11`) | all; ladders manage N rung orders |
| `MONITORING` | position open; exit policy active | drives TP/SL/deadline/funding gate |
| `EXITING` | exit order in flight | all |
| `CLOSED` | position closed | records `exit_reason` (`00_globals.md` §10.1) |
| `NO_POSITION` | terminated without a managed position | `limit_expired`, `ladder_no_fills`, S6 pre-fund failures (`00_globals.md` §10.2) |
| `ABORTED` / `ENTRY_FAILED` | preflight/entry failure | `kill_switch`, submit/reject codes |

**Exit-policy dispatch.** `MONITORING` behavior is delegated to the strategy's exit-policy *kind* (`00_globals.md` §Inventory): `timed` (S1), `funding_fee_event` (S1-WS), `sl_tp_deadline` (S3a/S4.*a), `sl_tp_deadline_retracement_funding_event` (S2), `sl_tp_deadline_post_funding_event` (S6). Each kind is a small handler consuming `MarketTick` / `FundingFeeAccrued` / `Timer` events — one handler per kind, selected by registry, no per-strategy branching in the runtime.

**S6 note.** S6's elaborate entry state machine (PRE_FUNDING → WS gate → MAIN reversal, `07_strategy_6.md` §2–§3) is modeled as a sub-machine inside `SUBMITTING_ENTRY`/`MONITORING`; its `error_code` set (`00_globals.md` §10.2) plugs into `NO_POSITION`/`ENTRY_FAILED`. S6's entry path is validated via its shadow → canary protocol (`07_strategy_6.md` §6).

---

## 6. Monitoring → exit orchestration

- **Entry:** execution layer (`11`) places the order(s); on `OrderUpdate(filled)` the intent enters `MONITORING`, position + funding trackers update.
- **Monitor:** the exit-policy handler reacts to real events in real time; the exit kinds and their triggers are exactly as specified per strategy (`00_globals.md` §10).
- **Exit:** first trigger wins (TP/SL/deadline/gate); siblings cancelled (OCO), reduce-only close as specified per strategy; then the post-exit sweep (`00_globals.md` §5.2) and accounting handoff (`15`).

---

## 7. Purity & reuse

The runtime imports only **ports** (`ExchangeAdapter`, `Repo`, `Clock`, `RiskGate`) — never a venue lib or the DB, so selection/preflight/intent logic is fully unit-testable against in-memory ports. This is the reason strategy behavior is defined once (in `01`–`07`) and referenced here rather than duplicated.
