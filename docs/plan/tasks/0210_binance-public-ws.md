# 0210 — Binance public WS streams

**Phase:** 3 — Binance adapter
**Depends on:** 0200
**Spec references:** `10_exchange_adapters_and_market_data.md` §7 (public WS streams), §8 (funding-rate data); `00_globals.md` §7 (60 s freshness), §8.1 (schedule re-read)

## Objective
The two public market-data feeds pushed onto the event bus from the native Binance WS client: predicted next funding rate → `FundingPredicted` and last price/trades → `MarketTick`, with adapter-side timestamps, REST fallback polls, automatic reconnect with backoff, and REST re-priming after a gap.

## Context for the agent
Freshness: the adapter timestamps every observation; a predicted rate older than 60 s is treated as no signal by the finder (0130 — the gate lives there; the adapter's job is honest `ts`). Subscription scope (`10` §7): predicted funding for the filtered perp-USDT universe; last-price narrowed to the shortlist around each event window to stay inside bandwidth budgets — expose `subscribeTicks(symbols)` / `unsubscribeTicks(symbols)` for the runtime to call. On Binance, mark-price stream carries the predicted funding rate — document the exact stream chosen in code.

## Scope
- In scope:
  - `src/adapters/exchanges/binance/public-stream.ts`: native-lib WS consumption → typed events on the bus; symbol denormalization at the boundary (0120 helpers); observation timestamps.
  - REST fallback pollers (through the 0200 limiter, general lane): `predictedFunding` poll when the stream is down; ticker poll for ticks.
  - Reconnect: exponential backoff, then REST snapshot re-prime before resuming stream consumption (no silent gap).
  - Dynamic tick subscription API used later by the runtime (subscribe shortlist, unsubscribe on close).
  - Unit tests against recorded/synthetic WS message fixtures (offline); env-gated integration test against live public Binance WS (no credentials needed).
- Out of scope: private streams (0220), the funding-settlement/`FundingSettled` synthesis (0290 owns gate logic; settled-rate REST read exists since 0190 via `fundingHistory`), other venues.

## Implementation notes
Design the stream consumer as: raw socket message → parse → normalize → publish; make the parse/normalize step a pure function unit-tested from fixture messages. Reconnect state machine should be its own small utility — 0220 and every other venue reuses it. Do not let WS handlers throw into the socket library: map errors via 0200 and log.

## Verification (definition of done)
1. `npm run verify` — green offline: fixture-driven tests prove message → event mapping (fields, normalized symbol, ts), duplicate-message tolerance, and that a simulated disconnect triggers re-prime-then-resume in order.
2. Env-gated integration: connect to live Binance public WS, receive ≥ 1 `FundingPredicted` and ≥ 1 `MarketTick` for a subscribed major symbol within a bounded window, clean close; suite skips without the flag.
3. Fallback poller test: with the stream scripted down, REST poll produces `FundingPredicted` events through the limiter.
