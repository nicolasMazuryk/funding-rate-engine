# 0060 — Minimal fake exchange adapter

**Phase:** 1 — Walking skeleton
**Depends on:** 0030
**Spec references:** `0000_agentic-development-environment.md` §5 (a fake venue implementing `ExchangeAdapter`), §8 (vertical slice); `10_exchange_adapters_and_market_data.md` §2 (interface), §4 (Instrument)

## Objective
A happy-path in-memory venue implementing the full `ExchangeAdapter` port: a couple of hardcoded instruments, an emitting `FundingPredicted` feed, market orders that fill immediately at a scripted price, and `OrderUpdate`/`PositionUpdate`/`BalanceUpdate` emission. Just enough venue for the walking skeleton (0090) to trade against with zero credentials.

## Context for the agent
This is the *minimal* sim venue; deterministic fault injection (partial fills, disconnects, dup events, 429s…) is a separate later task (0160) that extends this class — design for that extension (scriptable behavior), but implement only the happy path now. Lives under `src/adapters/` (impure side is fine here, but it should actually be pure/in-memory — it still must not leak into core).

## Scope
- In scope:
  - `src/adapters/sim/sim-exchange.ts` implementing every `ExchangeAdapter` method (per `10` §2): `init`/`close`, account-setup methods as no-op recorders, `markets()`/`normalize()` over 2–3 hardcoded `Instrument`s (include one with `contractSize ≠ 1` or a `1000X` multiplier for later denomination tests), order placement filling MARKET orders instantly at a scripted mark price, `getOrder`/`getPositions`/`getBalance` reflecting internal state, `predictedFunding`/`fundingHistory` from a scripted series, and `streams` publishing events onto the bus.
  - A small scripting surface: `setPrice(symbol, px)`, `setPredictedFunding(symbol, rate, ts)`, `settleFunding(symbol, rate, T_settle)` (emits `FundingSettled` and, for open positions, `FundingFeeAccrued`).
  - Unit tests for fill/position/balance bookkeeping.
- Out of scope: fault injection & scenario files (0160), limit/stop order resting logic beyond a trivial version if convenient (full behavior in 0160), `test/CLAUDE.md` (0160), latency simulation.

## Implementation notes
Bind the sim to the virtual clock via the `Clock` port so event timestamps are deterministic. Keep venue state (orders, positions, balances) in plain maps; emit events through the same bus interface real adapters will use. Reduce-only semantics: cap close qty at position qty (needed by skeleton exit).

## Verification (definition of done)
1. `npm run verify` — green.
2. Unit tests: placing a BUY MARKET order emits `OrderUpdate(FILLED)` with the scripted price and updates `getPositions()`; a reduce-only SELL flattens; `settleFunding` on an open long emits `FundingFeeAccrued` with the right sign; no position → no accrual event.
3. Type check proves `SimExchange` satisfies `ExchangeAdapter` (no casts).
