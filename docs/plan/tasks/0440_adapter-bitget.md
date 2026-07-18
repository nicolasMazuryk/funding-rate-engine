# 0440 — Bitget adapter

**Phase:** 6 — Remaining venues
**Depends on:** 0260
**Spec references:** `10_exchange_adapters_and_market_data.md` (all); `11_execution_and_account_state.md`; `17_testing.md` §3

## Objective
The complete Bitget adapter behind the one interface, following the Binance pattern — clients, error mapping, public/private WS, WS-first orders, fixtures, testnet tier where usable — zero core changes.

## Context for the agent
Structure and process identical to 0420 (the template task — read it first). Bitget particulars to investigate and record: native lib `bitget-api` (ROADMAP A5 fallback applies), passphrase auth (supported by the `.env` schema), demo/testnet availability and fidelity (Bitget offers a demo environment; assess which `17` §3 checklist items it can actually prove — expect gaps, record them in `docs/testnet-notes.md`), funding-fee event delivery semantics on the private stream, symbol suffix conventions (`…USDT_UMCBL`-era vs current v2 naming — normalize per 0120).

## Scope
- In scope:
  - `src/adapters/exchanges/bitget/` mirroring the Binance layout: factory, adapter, error map, public stream, private stream, WS orders.
  - Fixtures via `npm run capture -- --venue bitget`; completed `exchanges.yaml` Bitget profile with any confirmed deltas.
  - Fixture-driven unit tests + `npm run test:testnet -- --venue bitget` (or documented skip set if the demo environment can't support parts of the checklist).
- Out of scope: core changes (`git diff src/core/` empty), live-money runs.

## Implementation notes
Follow the venue-task checklist established by 0420/0430: capture fixtures early, table-driven error map, validate funding-fee `fundingTime` against `fundingHistory` REST before trusting the stream, update `src/adapters/CLAUDE.md` venue-quirk table.

## Verification (definition of done)
1. `npm run verify` — green offline (fixture-driven parse/map/normalize tests).
2. Captured Bitget fixtures committed; no secret material (grep).
3. With demo credentials: `npm run test:testnet -- --venue bitget` — checklist pass/skip-with-reason, flat at exit; clean skip without credentials.
4. `git diff` clean under `src/core/`; `docs/testnet-notes.md` updated with Bitget capabilities/gaps.
