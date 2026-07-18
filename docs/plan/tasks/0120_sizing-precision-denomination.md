# 0120 — Sizing, precision, and denomination math

**Phase:** 2 — Core deepening + simulation
**Depends on:** 0030
**Spec references:** `00_globals.md` §4 (sizing), §G-R (ladder split); `11_execution_and_account_state.md` §2 (order request & sizing), §3 (precision & min-limit enforcement); `10_exchange_adapters_and_market_data.md` §4 (normalization, precision & denomination)

## Objective
The pure math every order flows through: `qty = amountUsd / price / contractSize` floored to lot step, price rounded to tick, min-notional/min-qty feasibility checks, the ladder largest-remainder split with sub-min-notional rung dropping, and base-unit denomination normalization (`1000PEPE` ↔ `PEPE`). Property-tested, because a wrong `contractSize` silently mis-sizes every order.

## Context for the agent
Pure core/execution utilities — no I/O, consumed later by preflight (0140), the order manager (0230), and strategies. Binding rules: price tick → **round** (never reject); lot step → **floor**, result 0 → infeasible; `qty × price < minNotional` → skip symbol; ladder: `amountUsd` split across rungs by largest-remainder over the lot step, rungs below min-notional dropped at placement so a ladder may go out with fewer than `ladderCount` orders; a symbol whose **top** rung fails `minCost` is skipped entirely (`§G-R`, `05` §1). Denomination: all internal math in base units; venue multiple applied only at the API boundary.

## Scope
- In scope:
  - `src/execution/sizing.ts`: qty computation, tick rounding, lot flooring, feasibility result type (`ok | skip_symbol` with reason).
  - Ladder split: `splitLadder(amountUsd, rungPrices, instrument) → rungs[]` (largest-remainder, drop sub-min-notional, may return fewer rungs; empty → skip).
  - `src/execution/denomination.ts` (or in `src/adapters/shared/`): `toVenueUnits`/`fromVenueUnits` given an `Instrument` multiplier; normalized-symbol mapping helpers.
  - Reduce-only cap helper: exit qty ≤ tracked position qty (`11` §3).
  - Property-style tests (`17` §2): floored qty never violates lot step; split conserves total within one lot step × rung count; every emitted rung ≥ min-notional; venue-unit round-trip is identity within precision.
- Out of scope: preflight orchestration (0140), instrument construction from ccxt (0190), fee math (0150/0390).

## Implementation notes
Precision arithmetic: avoid float drift on lot-step flooring — use integer step counts (`Math.floor(qty/step)*step` with epsilon guard) or a tiny decimal helper; test the pathological cases (step 0.001, qty 0.0299999…). Largest-remainder: distribute `amountUsd/price` derived qty in lot-step quanta, remainders to the largest fractional parts — deterministic tie-break by rung index.

## Verification (definition of done)
1. `npm run verify` — green.
2. Unit + property tests cover: `1000PEPE` example from `10` §4 (internal `PEPE` base units, venue conversion at boundary); a 5-rung split where one rung drops below min-notional → 4 rungs placed; top-rung infeasible → skip; qty flooring to 0 → infeasible.
3. Deterministic: repeated split runs give identical rungs.
