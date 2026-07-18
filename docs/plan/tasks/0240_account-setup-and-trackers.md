# 0240 — Account setup + position and funding trackers

**Phase:** 3 — Binance adapter
**Depends on:** 0230
**Spec references:** `11_execution_and_account_state.md` §1 (account setup), §8 (position tracking), §9 (funding-fee tracking); `00_globals.md` §4 (leverage hard reject), §5.3 (orphan detection)

## Objective
The account-state layer: one-way position mode, isolated margin, and leverage applied per tradable symbol in advance with `setLeverage` failure a hard reject; an authoritative in-memory position tracker fed by `PositionUpdate` and reconciled against REST `getPositions` at key moments; and the funding-fee tracker that records `FundingFeeAccrued` amounts per intent and backfills from `fundingHistory`.

## Context for the agent
Account plumbing is set once in advance, never mid-trade (`11` §1); calls are idempotent on the venue and the adapter records applied state to skip redundant calls. A symbol whose leverage/mode can't be set does not trade (hard reject → preflight's account-setup check from 0140 now has a real source). Position tracker reconcile moments (`11` §8): after entry fill, after exit, periodic tick; REST is normative ground truth for exit sizing. Orphan detection: venue position with no owning intent → emit a typed orphan event (handling/auto-flatten is 0380 — here, detect and alert). Reduce-only exits cap at tracked qty (0120 helper).

## Scope
- In scope:
  - `src/adapters/exchanges/binance/account-setup.ts`: `setPositionMode('one_way')`, `setMarginMode(symbol,'isolated')`, `setLeverage(symbol, n)` with applied-state cache and per-exchange leverage delta honored (`00_globals` §6 via 0110 config).
  - `src/execution/position-tracker.ts`: per-symbol position from `PositionUpdate`s, REST reconcile at the three moments (scheduled via 0050 for the periodic tick), divergence handling (REST wins; diff logged), orphan detection emitting a risk event.
  - `src/execution/funding-tracker.ts`: match `FundingFeeAccrued` to open intents' symbols, record signed amounts + `fundingTime`; REST `fundingHistory` backfill query surface for reconciliation (0400) and §G-R actual-accrual booking.
  - Preflight integration: account-setup-applied check now backed by real state.
  - Sim + unit tests; env-gated testnet test for account setup idempotency.
- Out of scope: orphan auto-flatten + stale sweep (0380), reconciliation records in Postgres (0400), S6 net-qty confirm specifics (0350 uses `getPositions` directly per `07` §2).

## Implementation notes
Tracker state must be rebuildable: constructor accepts a REST snapshot (used by re-prime from 0220 and recovery in 0370). Funding matching here is by symbol + time bucket only — the ±5 s intent-gate tolerance lives in 0290; the tracker records everything it sees (unmatched accruals are kept — reconciliation cares about them).

## Verification (definition of done)
1. `npm run verify` — green: sim tests prove reconcile-after-entry corrects a scripted tracker/venue divergence with REST winning; orphan scenario (venue position, no intent) emits the orphan event; funding tracker books a late `FundingFeeAccrued` (0160 fault) to the right intent.
2. `setLeverage` scripted failure → symbol marked untradable → preflight hard-rejects it (integration through the sim).
3. Env-gated testnet: applying mode/margin/leverage twice performs the venue calls once (cache assert), no error on repeat startup; suite skips without credentials.
