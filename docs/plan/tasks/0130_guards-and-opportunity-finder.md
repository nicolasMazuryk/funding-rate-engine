# 0130 — Engine guards, opportunity finder, strategy registry

**Phase:** 2 — Core deepening + simulation
**Depends on:** 0090, 0110
**Spec references:** `00_globals.md` §7 (engine-level guards), §3.2 (rate rule); `12_strategy_runtime_and_intent_lifecycle.md` §1 (scheduler workflow), §2 (opportunity finding); `08_system_overview.md` §5 (Registry pattern)

## Objective
The real HH:58 scan workflow replacing the skeleton's hardcoded finder: engine-level guards (0.1 pp threshold pre-filter, 60 s snapshot freshness gate, most-negative-first / most-extreme-first ordering), dispatch to strategy selection through a registry (no branching on strategy name), and entry-timer scheduling per candidate at `T_settle − entryOffsetSeconds`.

## Context for the agent
Guards run **before** any strategy-specific selection and are strategy-agnostic (`00_globals` §7): (1) only symbols whose predicted funding is within 0.1 pp of the enabled strategy's threshold are evaluated; (2) snapshots older than 60 s are *no signal*, never a stale trigger; (3) candidates ordered most-negative-first, most-extreme-first for S6 positive thresholds. Selection input is the **predicted** rate at decision time (`00_globals` §3.2). `T_settle` and interval are re-read per event (`00_globals` §8.1) — the finder receives the current funding schedule as part of its input snapshot. The strategy module interface defined here is what tasks 0280–0350 implement; the stub strategy from 0090 becomes the first registry entrant.

## Scope
- In scope:
  - `src/core/runtime/finder.ts`: pure function `(universe snapshot, predicted rates with timestamps, funding schedule, config, now) → ordered candidates`; implements the three guards.
  - `src/core/strategies/registry.ts` + `StrategyModule` interface: `select(candidate, config) → trigger?`, exit-policy kind id, and (later) policy hooks — keep the surface minimal; extend in 0280.
  - Scheduler wiring: scan timer → finder → per-candidate entry timers (via 0050), covering symbols on 1/2/4/8 h intervals only when settlement is imminent.
  - Migrate the 0090 skeleton to this path (stub strategy registered; golden trace updated if bytes change — regenerate deliberately and note in commit).
  - Unit tests for each guard in isolation and combined.
- Out of scope: preflight (0140), cost model (0150), real strategy selection logic (0280+), live predicted-funding feed (0210).

## Implementation notes
The freshness gate compares snapshot ts against the injected clock — test with the virtual clock at exactly 60 s (stale) and 59 s (fresh); pick a boundary convention and test it. Ordering: sort by signed rate ascending for negative-threshold strategies; for S6 with positive threshold sort descending; encode as "distance past threshold, most extreme first" to keep it uniform. Registry: plain `Map<StrategyId, StrategyModule>` — no DI container (`08` §5 anti-list).

## Verification (definition of done)
1. `npm run verify` — green, golden replay still deterministic.
2. Unit tests: symbol at threshold−0.05 pp evaluated, at threshold−0.15 pp not; 61 s-old snapshot produces no candidate; ordering asserted for a mixed candidate set; S6-style positive threshold orders most-positive-first; a symbol with a 4 h interval appears only in the scan preceding its settlement.
3. Finder is pure: same inputs → same outputs (repeat-run test).
