# 0280 — Strategy S1 + `timed` exit kind + composition root

**Phase:** 4 — Strategies
**Depends on:** 0270
**Spec references:** `01_strategy_1.md` (all sections); `00_globals.md` §G-L, §3.1, §7, §11-R2/R10; `12_strategy_runtime_and_intent_lifecycle.md` §5–§6; `08_system_overview.md` §8 (end-to-end flow)

## Objective
The first real strategy, end to end: S1 (negative-funding LONG, timed exit) as a registry strategy module with §G-L selection, BUY-MARKET entry at `T_settle − entryOffsetSeconds`, the `timed` exit-policy handler (SELL MARKET reduce-only at `T_settle + exitOffsetSeconds`, always `exit_reason = timed`), the post-exit sweep hook, and the finished `main.ts` composition root that boots a real instance from config. The stub strategy from 0090 is deleted.

## Context for the agent
S1 is deliberately first: simplest exit, no WS-order mandate (REST path acceptable), no resting orders on the happy path, no events awaited (never subscribes funding-fee stream — `01` §2). Selection is pure §G-L: `F_predicted ≤ negativeFundingThresholdPercent`, market trading, engine guards pass. The accrual test (`00_globals` §3.1) is fill-time-based: an entry that fills after `T_settle` earns nothing — the trade record's `funding_received` flag must reflect actual fill time (booked economics finalized in 0390; record the raw facts now). `exitOffsetSeconds` bound > 5 (R2). Post-exit sweep (`00_globals` §5.2): after exit, cancel lingering reduce-only orders for the symbol — on S1's happy path this is a no-op, but the hook must exist and run (full sweep semantics with real cancels exercised by later strategies; stale-sweep-before-entry is 0380).

## Scope
- In scope:
  - `src/core/strategies/strategy-1.ts`: selection + parameterization from the canonical schema slice; registered as `strategy_1`.
  - `src/core/intent/exit-policies/timed.ts`: the `timed` handler — schedules the exit timer, commands the reduce-only market exit, sets `exit_reason = timed`.
  - Post-exit sweep hook in the engine (async after exit transition, per `00_globals` §5.2).
  - `src/main.ts`: full composition root — load `EffectiveConfig` (0110), build adapter by factory/registry (sim or binance by env for now), wire engine, start scheduler; fail-loud startup order per `09` §5.
  - Delete stub strategy; migrate goldens.
  - Tests: unit (selection incl. threshold boundary; exit timing); sim scenarios — happy path (fill before `T_settle`, funding accrued flag true), late-fill path (fill after `T_settle` → `funding_received` false — the canonical false-positive generator, `00_globals` §3.1), entry reject → `ENTRY_FAILED`; e2e happy path asserting the full trade record and `exit_reason = timed`; golden replay for the happy path.
- Out of scope: funding gate (0290), P&L decomposition/booking (0390), live runs (0480), other §G-L strategies.

## Implementation notes
The exposure window arithmetic (`01` §3: ≈ entryOffset + exitOffset + 2×latency) is design documentation, not code. Keep the strategy module free of order mechanics — it declares intent shape (side, order type, timing offsets) and the exit-policy kind; the runtime + execution layer do the rest. This module is the template for 0300–0350: invest in its clarity.

## Verification (definition of done)
1. `npm run verify` — green; `npm run test:e2e` — S1 scenarios pass.
2. Sim scenario asserts: entry decision at `T_settle − 3 s` (proposed config), exit order commanded at `T_settle + 6 s` on the virtual clock, `exit_reason = timed` on every closed S1 intent.
3. Late-fill scenario: `funding_received = false` recorded despite settlement occurring while position open-but-filled-late.
4. `node --env-file=.env dist-or-tsx src/main.ts` (documented dev command) boots against the sim profile and exits cleanly on SIGTERM (smoke, documented in README/CLAUDE.md).
