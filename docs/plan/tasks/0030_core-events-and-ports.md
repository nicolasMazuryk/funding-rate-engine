# 0030 — Core event types, event bus, ports, purity enforcement

**Phase:** 1 — Walking skeleton
**Depends on:** 0010
**Spec references:** `08_system_overview.md` §4 (The event stream), §3 (Layers), §7 (Layout); `10_exchange_adapters_and_market_data.md` §2 (Adapter interface), §9 (Purity notes); `12_strategy_runtime_and_intent_lifecycle.md` §7 (Purity & reuse); `00_globals.md` §1.1 (notation); `0000_agentic-development-environment.md` §2 (nested CLAUDE.md — core)

## Objective
The typed spine of the system: all eight event types from `08` §4, a synchronous in-process event bus with per-symbol FIFO ordering, and the four port interfaces the core depends on (`ExchangeAdapter`, `Repo`, `Clock`, `RiskGate`) — plus mechanical enforcement that `src/core/` never imports I/O. Every later task builds against these contracts.

## Context for the agent
This is interface-first decomposition: contracts now, implementations later. The core purity rule (`08` §3) is the load-bearing architecture decision — it is what makes the runtime testable without a venue. The `ExchangeAdapter` interface shape is given in `10` §2 verbatim; `Repo` is only sketched by `14` §7 (define the minimal surface the skeleton needs; it grows in later tasks). Events are immutable value objects.

## Scope
- In scope:
  - `src/core/events/types.ts`: `Timer`, `FundingPredicted`, `FundingSettled`, `FundingFeeAccrued`, `MarketTick`, `OrderUpdate`, `PositionUpdate`, `BalanceUpdate` (fields per `08` §4 table), a discriminated-union `EngineEvent`, immutable (readonly fields).
  - `src/core/events/bus.ts`: synchronous typed pub/sub, per-symbol FIFO ordering guarantee, plus a bus interface in `src/core/ports/`.
  - `src/core/ports/`: `ExchangeAdapter` (per `10` §2, including `streams`), `Clock` (now / schedule-timer surface consumed by 0050), `Repo` (append intent transition, load non-terminal intents — minimal), `RiskGate` (single `check(intent)` surface).
  - Supporting value types: `Instrument` (per `10` §4 fields), `OrderRequest`/`OrderAck`/`Order`, `Position`, `Balance`, side/state enums.
  - Purity enforcement: ESLint `no-restricted-imports` (or import plugin zones) forbidding `src/core/**` from importing `src/adapters/**`, `src/persistence/**`, `src/execution/**`, and any I/O package (`ccxt`, `pg`, `ws`, `pino`, `drizzle-orm`, node `fs`/`net`/`http`).
  - `src/core/CLAUDE.md`: the purity constraints and what belongs in core (JIT item from spec 0000 §2).
- Out of scope: FSM engine (0040), any port implementation (0050+), Zod config schemas (0100), strategy types beyond a placeholder `StrategyId` union.

## Implementation notes
Keep the union closed and exhaustive — downstream switches rely on `never`-checking. Use branded/opaque types sparingly; plain readonly interfaces suffice. The bus needs an explicit `publish` that dispatches synchronously in subscription order; per-symbol FIFO falls out of synchronous dispatch — add a test proving ordering with interleaved symbols. Unit conventions from `00_globals` §1.2 (percent vs fraction) belong as doc comments on the relevant fields now, so they propagate.

## Verification (definition of done)
1. `npm run verify` — green; new unit tests cover: bus delivers events in publish order per symbol; multiple subscribers each receive events; exhaustiveness helper compiles.
2. Add a scratch file in `src/core/` importing `fs` — `npm run lint` fails; revert.
3. `src/core/CLAUDE.md` exists and states the import restrictions.
