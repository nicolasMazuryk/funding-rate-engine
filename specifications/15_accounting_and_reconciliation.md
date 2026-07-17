# Accounting, Reconciliation & Trade Analytics

**Document:** `15_accounting_and_reconciliation.md` · includes `00_globals.md` by reference (P&L skeleton §1.1, output vars §10.3)
**Covers:** post-trade accounting, system↔exchange reconciliation, P&L attribution, and trade analytics.

**Conclusion first.** After every intent closes, the engine reconciles its internal record against **venue ground truth** (fills, funding, fees from REST/history) and produces a per-intent **P&L decomposition** using the exact formulas the strategy files define. Reconciliation catches any drift between what the engine thinks happened and what the venue actually did; analytics roll the reconciled trades into the metrics the strategy specs require (path mix, `t_drop_offset` buckets, funding capture ratios). Live output uses the **same schema** as backtest output (`00_globals.md` §10.3), so live-vs-backtest comparison is direct.

---

## 1. Post-trade accounting (per intent)

On intent close (`12` §5), assemble the trade record:

```
DELTA_PNL   = (P_exit − P_entry)/P_entry × 100      # long; short/ladder/S6 per strategy §4
FUNDING_PNL = ±|F| or 0                             # per accrual rule, 00_globals §5.1
FEES        = Σ per-fill (taker/maker) from actual fills
NET_PNL     = DELTA_PNL + FUNDING_PNL − FEES        # 00_globals §1.1
```

- Uses **realized fills** (from `fills`, `14`) and the **settled** funding amount (from `funding_events`), not assumptions — slippage and fees are whatever actually filled.
- Per-strategy decomposition is taken from each strategy's §4 (referenced, not re-derived): S1/S1-WS/S2 funding-collection; S3a short with funding cost; S4.*a `FUNDING_PNL = 0`; S6's `MAIN_DELTA + PRE_FUNDING_DELTA + FUNDING_PRE`.
- Output fields match `00_globals.md` §10.3: `P_entry`, `P_exit`, `P_avg`, `delta_pnl`, `funding_pnl`, `fee_cost`, `net_pnl`, `exit_reason`, `error_code`, `hold_duration_s`, `fill_count`, `funding_received`, `t_drop_offset_s`.

---

## 2. Reconciliation (system ↔ exchange)

Runs on intent close and on a periodic sweep. Compares the engine's record to venue ground truth:

| Dimension | Engine source | Venue source | On mismatch |
|---|---|---|---|
| Fills (price, qty, fee) | `fills`/`orders` (`14`) | REST `getOrder` / trade history | write diff to `reconciliation`; venue wins for accounting; alert if beyond tolerance |
| Position (qty, side) | position tracker (`11` §8) | REST `getPositions` | orphan/desync → `13` §5 |
| Funding accrual | `funding_events` (`11` §9) | REST `fundingHistory` | correct booked amount; re-attribute (S6, §3) |
| Balance | `BalanceUpdate` | REST `getBalance` | reconcile margin/fees |

- **Venue is truth for money**; the engine's tracked values are corrected to match and the diff is recorded for audit. Diffs beyond a tolerance raise an alert (possible bug or missed event).
- Reconciliation closes the loop on the known two-sided uncertainties flagged in the strategy specs (e.g. S1-WS ±5 s event matching, `02_strategy_1_ws.md` §3; S6 funding attribution audit, `07_strategy_6.md` §2/§6.2).

---

## 3. P&L attribution

- **Per leg:** delta vs funding vs fees, so it's clear whether an intent made money on the drop, the funding, or lost to fees/slippage — the decomposition each strategy's profit condition is written against.
- **S6 attribution:** funding charge is attributed to the PRE_FUNDING leg (only leg open at `T_settle`); per-venue ledger labeling is confirmed against income statements during canary and back-filled here (`07_strategy_6.md` §2 table, §6.2.d). Until confirmed, the conservative default booking is used and flagged.
- **Funding-received flag** (`00_globals.md` §5.1) distinguishes intents that actually collected/paid funding from those whose fill landed the wrong side of `T_settle` — critical for honest expectancy.

---

## 4. Trade analytics (the reports the strategy specs demand)

Analytics aggregate reconciled trades into exactly the metrics each strategy file requires in its §4/§6 report requirements:

| Metric | Required by |
|---|---|
| Path mix (`tp_hit` / `sl_hit` / `deadline` frequencies) | S2, S3a, S4.1a, S4.2a |
| `NET_PNL` bucketed by `t_drop_offset_s` | S1, S1-WS, S3a |
| Realized `|DELTA_PNL| / |F|` distribution | S1-WS |
| Deadline-exit frequency & `DELTA_PNL` distribution | S2 |
| Fill-count histogram, `P_avg` vs `P_ref`, `limit_expired`/`ladder_no_fills` rate | S4.1a, S4.2a |
| Drop-depth ÷ `|F|` distribution (validates the empirical model, `00_globals.md` §2) | S3a |
| Realized PRE overhead in bp, event-timeout rate, MAIN slippage distribution | S6 (canary acceptance, `07_strategy_6.md` §6.2) |

Because live output shares the schema and enums with backtest output (`00_globals.md` §10.3, §12), the **same analytics code** runs on both — the primary tool for validating that live behavior matches the backtested edge (and for feeding S6's live calibration set, `07_strategy_6.md` §6.2).

---

## 5. Fleet-level rollup

Each instance produces its own reconciled trade records (its own DB, `16`). A read-only rollup aggregates across instances for fleet-wide P&L, per-strategy and per-exchange breakdowns, and cross-venue funding-attribution audits — without coupling instances at runtime (instances stay isolated; the rollup reads their databases offline/async).

---

## 6. Scope

Accounting is a **sidecar**: it reads persisted facts (`14`) and venue history, and writes reconciled records and metrics. It has no authority to place orders — corrections it finds either self-resolve (booking adjustments) or escalate to risk (`13`, e.g. orphan flatten). This keeps the money-truth path auditable and separate from execution.
