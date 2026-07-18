# 0140 — Preflight, risk gate, kill switch

**Phase:** 2 — Core deepening + simulation
**Depends on:** 0110, 0120, 0130
**Spec references:** `12_strategy_runtime_and_intent_lifecycle.md` §3 (Preflight); `13_risk_and_failure_modes.md` §1 (risk gate), §2 (kill switch); `00_globals.md` §5.1 (kill switch semantics), §10.2 (`kill_switch` error code)

## Objective
The single fail-fast choke point before any venue write: full preflight (kill switch, risk gate, balance, precision/min-limits, account-setup-applied, market status) terminating failed intents with the correct `error_code` and zero side effects, plus the risk gate (`max_concurrent_intents`, `max_notional_usd`, breaker-open input) and the kill-switch state machine (`off | paused | flatten`) with its preflight rejection semantics.

## Context for the agent
Preflight is deliberately the *one* place "should this trade exist?" is answered (`12` §3) — every strategy inherits identical safety. Kill switch: `paused`/`flatten` reject every new intent with `error_code = kill_switch` **before any exchange API call** — engine-internal, no venue activity from `paused` (`00_globals` §5.1). The `flattenAll()` side of `flatten`, breaker escalation, and kill-switch persistence are task 0380 — here, model the state and expose a transition API plus a port the risk layer implements. Risk defaults: `13` §1 values are schema defaults; instance YAML may tighten (ROADMAP assumption A3). Balance check: free margin ≥ `amountUsd / leverage` from latest `BalanceUpdate`.

## Scope
- In scope:
  - `src/core/runtime/preflight.ts`: ordered checks per `12` §3 table, each returning pass or a typed rejection mapping to the table's fail action (`kill_switch`, risk reject, `InsufficientBalance`, precision/min-limit skip, hard reject on missing account setup, market-status skip); wired between entry timer and order submission in the engine.
  - `src/risk/gate.ts` implementing the `RiskGate` port: concurrency, notional, breaker-open (boolean input port for now).
  - `src/risk/kill-switch.ts`: state enum, bootstrap from `EffectiveConfig` (`KILL_SWITCH` env, `09` §2), transition API, subscription for state changes; in-memory + WAL-logged transitions (persistence table in 0360/0380).
  - Intent-machine integration: preflight failure → `ABORTED` with `error_code`, WAL-appended.
  - Unit tests per check, including ordering (kill switch checked first — no balance lookup when paused).
- Out of scope: `flattenAll()` + escalation + persistence (0380), circuit-breaker implementation (0380), live balance events (0220).

## Implementation notes
Keep every check a pure predicate over an injected snapshot (`{killSwitch, balances, instrument, accountSetupState, marketStatus, openIntents}`) so tests need no mocks. The precision/min-limit check reuses 0120's feasibility functions. Distinguish "reject intent with error_code" (intent existed) from "skip symbol" (no intent) exactly as `13` §6 does.

## Verification (definition of done)
1. `npm run verify` — green.
2. Unit tests: `paused` → intent `ABORTED (kill_switch)` with **zero** adapter calls (spy on the sim adapter); `max_concurrent_intents: 1` with one live intent → reject; balance below margin → reject; sub-min-notional symbol → skip (no intent row); all checks green → proceeds to submission.
3. E2E (sim): skeleton scenario with kill switch `paused` produces no orders and one ABORTED intent in Postgres.
