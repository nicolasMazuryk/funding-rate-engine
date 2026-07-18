# 0450 — Gate.io adapter

**Phase:** 6 — Remaining venues
**Depends on:** 0260
**Spec references:** `10_exchange_adapters_and_market_data.md` (all); `11_execution_and_account_state.md`; `17_testing.md` §3

## Objective
The complete Gate.io adapter behind the one interface, following the Binance pattern — clients, error mapping, public/private WS, WS-first orders, fixtures, testnet tier where usable — zero core changes.

## Context for the agent
Structure and process identical to 0420 (the template task — read it first). Gate.io particulars to investigate and record: native lib per canonical list (`gateio-api`; ROADMAP A5 substitution likely — Gate's maintained SDK naming has shifted; record what is used), contract-based sizing (Gate perpetuals are sized in **contracts** with per-symbol `contractSize` — the 0120 denomination path is load-bearing here, like OKX), testnet availability (Gate offers a futures testnet; assess fidelity per checklist item), WS order support scope (whether order placement over WS is supported for futures — if not, the profile's `ws_order_rest_fallback` mechanics and WS-mandatory startup guard interact: a venue without WS orders cannot host WS-mandatory strategies unless the profile enables the fallback; set the profile honestly and record the consequence for fleet planning in STATUS notes).

## Scope
- In scope:
  - `src/adapters/exchanges/gateio/` mirroring the Binance layout.
  - Fixtures via `npm run capture -- --venue gateio`; completed `exchanges.yaml` profile (incl. honest `ws_order_rest_fallback` / WS-order capability flags).
  - Fixture-driven unit tests incl. a `contractSize ≠ 1` sizing test; `npm run test:testnet -- --venue gateio` with skip-with-reason for unprovable items.
- Out of scope: core changes (`git diff src/core/` empty), live-money runs.

## Implementation notes
Follow the established venue-task checklist (0420). The WS-order-capability question must be answered explicitly in this task — it determines which strategies can ever run on Gate.io (`09` §6 guard) and therefore the real fleet matrix (0520 consumes this).

## Verification (definition of done)
1. `npm run verify` — green offline; contract-size sizing test passes.
2. Captured fixtures committed; no secret material (grep).
3. With testnet credentials: `npm run test:testnet -- --venue gateio` — checklist pass/skip-with-reason, flat at exit; clean skip without credentials.
4. `git diff` clean under `src/core/`; profile reflects measured WS-order capability; `docs/testnet-notes.md` updated.
