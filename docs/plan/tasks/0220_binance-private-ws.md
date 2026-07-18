# 0220 — Binance private WS streams

**Phase:** 3 — Binance adapter
**Depends on:** 0200
**Spec references:** `11_execution_and_account_state.md` §7 (private WS streams); `10_exchange_adapters_and_market_data.md` §5 (WsTimeout); `00_globals.md` §6 (funding-fee matching tolerance — see ROADMAP assumption A1)

## Objective
The authenticated user-data stream: `OrderUpdate`, `PositionUpdate`, `BalanceUpdate`, and `FundingFeeAccrued` events flowing from the native Binance private WS onto the bus, with listen-key lifecycle management, reconnect + REST re-prime (positions, balances, open orders), and correct funding-fee event shaping (`symbol`, `amount`, `fundingTime`).

## Context for the agent
This stream is what makes WS-gated strategies possible — `FundingFeeAccrued` is the live signal that funding actually credited (`11` §9). Event matching tolerance between `fundingTime` and expected `T_settle` is **±5 s** per ROADMAP assumption A1 (`00_globals` §6 and `02` §3 govern; `11` §7's ±30 s is noted as a discrepancy) — the tolerance constant is applied by the funding gate (0290); this adapter's job is faithful `fundingTime` delivery. Reconnect rule (`11` §7): re-prime from REST before resuming — no silent state drift. Binance specifics: user-data stream via listen key with keepalive, `ORDER_TRADE_UPDATE` / `ACCOUNT_UPDATE` events; income/funding events may need the income REST endpoint as a complement — investigate and document which source carries the funding fee in real time (the REST funding poll of 0290 is the safety net regardless).

## Scope
- In scope:
  - `src/adapters/exchanges/binance/private-stream.ts`: auth, listen-key create/keepalive/renew, message parse → typed events (pure, fixture-tested), symbol normalization, error mapping through 0200.
  - Reconnect with backoff + re-prime sequence: REST `getPositions`, `getBalance`, open orders by `clientOrderId` before resuming.
  - REST implementations on the adapter for `getOrder`, `getPositions`, `getBalance` (ccxt, through the limiter) — the ground-truth calls the re-prime and later tasks use.
  - Unit tests from recorded/synthetic private-stream fixtures: fills (full/partial), position change, balance change, funding fee; duplicate delivery tolerance.
  - Env-gated testnet integration test (Binance futures testnet keys): stream connects, keepalive survives > keepalive interval, re-prime works.
- Out of scope: order placement (0230), funding-gate matching logic (0290), position/funding trackers (0240).

## Implementation notes
Keep parse pure and total: unknown event types are logged and dropped, never thrown. `OrderUpdate` must carry `clientOrderId`, status, `fillPx`, cumulative qty — the order FSM (0230) is driven entirely by these. Timestamp discipline: venue event time and local receive time both recorded (S6 shadow metrics in 0490 need `T_event − T_settle`).

## Verification (definition of done)
1. `npm run verify` — green offline (fixture-driven parse/mapping tests, duplicate tolerance, re-prime ordering asserted with a scripted disconnect).
2. Env-gated testnet test: place nothing — just connect, hold through one keepalive cycle, force-close, reconnect, re-prime; all events well-typed; suite skips without credentials.
3. Funding-fee fixture produces `FundingFeeAccrued` with signed amount and `fundingTime` preserved to the millisecond.
