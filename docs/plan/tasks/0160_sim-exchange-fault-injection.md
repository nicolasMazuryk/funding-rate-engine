# 0160 — Fault-injecting sim exchange + scenario files

**Phase:** 2 — Core deepening + simulation
**Depends on:** 0040, 0060
**Spec references:** `0000_agentic-development-environment.md` §5 (Determinism and simulation harness), §2 (nested CLAUDE.md — test); `13_risk_and_failure_modes.md` §6 (failure catalog); `10_exchange_adapters_and_market_data.md` §5 (error taxonomy names); `17_testing.md` §4 (failure paths)

## Objective
The full deterministic misbehaving venue: the sim adapter (0060) extended to be told to produce partial fills, rejects, reduce-only violations, WS disconnect mid-order, duplicate and out-of-order `OrderUpdate`s, precision rejections, rate-limit 429s, and late funding-fee events — driven by typed **scenario files** so the failure catalog in `13` §6 becomes executable test cases rather than prose.

## Context for the agent
This is the machine agents develop every strategy against with zero credentials. Scenario format: TypeScript (ROADMAP assumption A4) — a typed script of timed venue behaviors bound to the virtual clock. Limit/stop resting-order semantics get real here (needed by S2/S3a/S4.x later): limits fill when the scripted price crosses, stops trigger, `expireAt` honored, OCO is engine-side (the engine cancels siblings — the sim only does what a venue does). Error emissions use the typed taxonomy names from `10` §5 (the shared union lands fully in 0200; declare the error type names now in core-visible form if not present).

## Scope
- In scope:
  - Extend `src/adapters/sim/`: resting limit/stop orders against scripted price paths; partial-fill sequences; scripted reject (precision, min-notional, reduce-only violation, margin); WS-stream drop/reconnect windows (private and public separately); duplicate + out-of-order event injection; delayed/absent `FundingFeeAccrued` (late by N s, or never); 429 emission per call class.
  - `test/scenarios/` scenario DSL: `scenario('name').at(ts, action)...` or data-object equivalent; a scenario runner that wires sim + virtual clock + engine and returns the trace.
  - One executable scenario per `13` §6 catalog row that is expressible pre-strategies (kill-switch rows and strategy-specific rows arrive with their owning tasks — leave TODO markers listing which task adds which scenario; at minimum: entry reject, limit-never-fills, WS-silence, rate-limit exhaustion, venue-unavailable streak, duplicate/out-of-order updates, crash-mid-intent via 0090's mechanism).
  - `test/CLAUDE.md` (JIT item from spec 0000 §2): tier definitions (unit/integration/e2e), scenario conventions, determinism rules (virtual clock only, no timeouts).
- Out of scope: strategy-specific scenarios (0280–0350 add theirs), fixture capture (0250), latency/slippage statistical modeling.

## Implementation notes
Determinism is absolute: every scripted behavior keys off virtual-clock time or event ordinals, never randomness (spec 0000 §5). Duplicate/out-of-order injection should wrap the stream emitter generically so any event type can be duplicated/reordered. Keep 0060's happy-path API stable — existing tests must not break; faults are opt-in per scenario.

## Verification (definition of done)
1. `npm run verify` — green, including the new scenario suite.
2. Scenario list covers (grep test names): partial fill, order reject, reduce-only violation, ws disconnect mid-order, duplicate OrderUpdate, out-of-order OrderUpdate, precision rejection, rate-limit 429, late funding fee, absent funding fee.
3. Running any scenario twice yields byte-identical traces.
4. `test/CLAUDE.md` exists and states the no-real-time rule.
