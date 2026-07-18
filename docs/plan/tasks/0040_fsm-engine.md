# 0040 — Shared FSM engine + intent and order state tables

**Phase:** 1 — Walking skeleton
**Depends on:** 0030
**Spec references:** `08_system_overview.md` §5 (FSM pattern); `12_strategy_runtime_and_intent_lifecycle.md` §5 (Intent FSM); `11_execution_and_account_state.md` §6 (Order FSM); `00_globals.md` §10 (exit_reason / error_code registries, R12)

## Objective
One tiny reusable FSM engine and the two state tables it drives: the intent FSM (`SELECTED → SUBMITTING_ENTRY → MONITORING → EXITING → CLOSED` plus `ABORTED`/`ENTRY_FAILED`/`NO_POSITION`) and the order FSM (`NEW → SUBMITTING → OPEN → FILLED` plus `PARTIAL`/`CANCELLED`/`EXPIRED`/`REJECTED`/`FAILED`). Illegal transitions throw. This is the DRY core reused by every strategy and the WAL.

## Context for the agent
Spec `08` §5 mandates **one** FSM utility with two state tables — do not build two FSM implementations. Terminal intent states carry exactly one of `exit_reason` (position closed) or `error_code` (no managed position) from the canonical registries in `00_globals` §10.1/§10.2 — model these as closed union types now (R12: every terminal path has exactly one enum value). The FSM engine is pure core; transitions will later be WAL-appended before side effects (0070), so the engine must expose a transition hook/callback.

## Scope
- In scope:
  - `src/core/intent/fsm-engine.ts`: generic `defineMachine<States, Payload>` — allowed-transition table, guarded `transition(from, to, payload)`, illegal-transition error, terminal-state query, and an `onTransition` observer hook (synchronous, called after validation, before state commit — the WAL gating point).
  - `src/core/intent/intent-machine.ts`: intent state table per `12` §5 diagram, `exit_reason` and `error_code` enums per `00_globals` §10 (all values, including all seven S6 codes), and the rule that `CLOSED` requires an `exit_reason`, `NO_POSITION`/`ABORTED`/`ENTRY_FAILED` require an `error_code`.
  - `src/execution/order-machine.ts` state table per `11` §6 (pure table + types; live wiring comes in 0230) — importable without I/O.
  - Unit tests: every legal transition, a representative illegal transition per state, no state reaches two terminals, every enum value is producible by some legal path (one test per enum value, per `17` §2).
- Out of scope: WAL persistence of transitions (0070), order manager wiring (0230), exit-policy dispatch (0280+), S6 entry sub-machine (0350).

## Implementation notes
Keep the engine under ~100 lines — a table lookup with hooks, not a framework. Type transitions so `transition('CLOSED', …)` is a compile error where statically known. `PARTIAL` keeps filled qty on `CANCELLED` (`11` §6) — encode as payload, not extra states. Property-style test (`17` §2): random walks through the legal table never reach two terminal states.

## Verification (definition of done)
1. `npm run verify` — green.
2. `npx vitest run test/unit/intent-machine.test.ts test/unit/order-machine.test.ts test/unit/fsm-engine.test.ts` — passes; test names enumerate every `exit_reason` and `error_code` value (grep the test output for `limit_expired`, `ladder_no_fills`, `close_pre_funding_failed` among others).
3. Illegal transition (e.g. `SELECTED → CLOSED`) throws with a typed error naming both states.
