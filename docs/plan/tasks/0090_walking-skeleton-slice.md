# 0090 — Walking-skeleton vertical slice + golden replay + crash-recovery tests

**Phase:** 1 — Walking skeleton
**Depends on:** 0050, 0060, 0070, 0080
**Spec references:** `0000_agentic-development-environment.md` §8 (Proof it works — the vertical slice), §6 (trace = replay artifact); `12_strategy_runtime_and_intent_lifecycle.md` §5 (intent FSM); `08_system_overview.md` §8 (end-to-end flow); `14_persistence_and_recovery.md` §5 (recovery, minimal)

## Objective
The thinnest end-to-end path, exactly as spec 0000 §8 demands: `Timer(HH:58)` → opportunity finder over a fake `FundingPredicted` stream → preflight stub → intent `SELECTED → SUBMITTING_ENTRY` → fake-adapter fill → `ENTRY_FILLED → MONITORING` → deadline exit → `CLOSED` with a valid `exit_reason` → WAL entries → Postgres persistence → reconciliation stub. Covered by unit tests, a golden replay test, a crash-recovery test at two states, and the Postgres integration test. After this, every future task extends a demonstrably working whole.

## Context for the agent
This is the proof that the machine works — wiring, not features. Use a **stub strategy** (hardcoded threshold check + timed exit), not the real S1 (which lands in 0280 with full spec semantics). "Preflight stub" = a single kill-switch-style boolean check; the real preflight is 0140. "Reconciliation stub" = after CLOSED, compare engine fill record vs `simExchange.getPositions()/getOrder()` and log a diff (real reconciliation is 0400). Structured trace: every event → intent transition appended as JSONL — the same artifact the replay test consumes (spec 0000 §6: logs and golden traces are one thing).

## Scope
- In scope:
  - `src/core/runtime/engine.ts` (or similar): wires bus, scheduler, finder-minimal (pick symbols whose scripted predicted funding ≤ a hardcoded threshold), stub strategy, intent machine with WAL observer, sim adapter, repo, forwarder.
  - A minimal composition entry usable from tests (not the full `main.ts` yet).
  - Trace writer: JSONL event/transition trace via the WAL + an events log (pino added here; structured JSON only).
  - Golden replay test: run the scenario on the virtual clock, capture the trace, compare against a committed golden file (byte-stable: virtual timestamps, no wall clock, stable ordering).
  - Crash-recovery test at **two states**: kill after `SUBMITTING_ENTRY` WAL append (before fill) and during `MONITORING`; restart engine from WAL + sim venue state; assert deterministic completion to `CLOSED` with no duplicate order submission (recovery logic here is minimal and local to the skeleton; the full `14` §5 sequence is 0370).
  - E2E-ish test through real Postgres reusing 0080's integration setup.
- Out of scope: real S1 semantics (0280), full preflight/risk (0140), full recovery matrix (0370), replay CLI (`scripts/replay.ts`, 0170).

## Implementation notes
Determinism is the hard requirement: trace bytes must be identical across runs — inject the clock everywhere, sort any map iteration, fixed JSON key order (stable stringify). Keep the stub strategy visibly a stub (`src/core/strategies/stub.ts`, marked for replacement in 0280). The crash tests should simulate crash by discarding in-memory state and re-running startup against the surviving WAL file + sim state — no actual process kill needed.

## Verification (definition of done)
1. `npm run verify` — green, including the new golden replay test and both crash-recovery tests.
2. Golden test run twice in a row — identical trace bytes (no flaky ordering).
3. With docker Postgres up: `npm run test:integration` — the slice persists intent + transitions to `intents`/`intent_wal`, and the final intent row state is `CLOSED` with `exit_reason` set.
4. Deleting the golden file and regenerating (documented one-liner) reproduces it exactly.
