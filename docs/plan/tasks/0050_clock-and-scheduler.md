# 0050 — Clock port implementations + scheduler timers

**Phase:** 1 — Walking skeleton
**Depends on:** 0030
**Spec references:** `12_strategy_runtime_and_intent_lifecycle.md` §1 (Scheduler); `0000_agentic-development-environment.md` §5 (virtual time); `00_globals.md` §8.1 (T_settle re-read per event)

## Objective
Two implementations of the `Clock` port — a real clock and a **virtual clock** that tests advance instantly to `HH:58`, `T_settle`, or any deadline — plus the scheduler that emits `Timer` events (hourly `HH:58:00` scan; per-candidate entry at `T_settle − entryOffsetSeconds`; per-intent deadline timers). No `setTimeout` in tests, ever, from this point on.

## Context for the agent
The virtual clock is the determinism cornerstone of the whole test harness (spec 0000 §5). The scheduler is pure core: it consumes the `Clock` port and publishes `Timer` events onto the bus (0030); it never sleeps or polls. `T_settle` and the funding interval are re-read per event, never cached per symbol (`00_globals` §8.1) — the scheduler API must take settlement times as inputs, not compute them from a cached schedule.

## Scope
- In scope:
  - `src/adapters/clock/real-clock.ts` (system time + real timers) and `src/adapters/clock/virtual-clock.ts` (manual `advanceTo(ts)` / `advanceBy(ms)`, firing due timers in timestamp order, deterministic tie-break).
  - `src/core/runtime/scheduler.ts`: registers the hourly `HH:58:00` scan timer, one-shot entry timers at `T_settle − entryOffsetSeconds`, and arbitrary deadline timers; each fire publishes a typed `Timer` event with a `kind` (`scan` | `entry` | `deadline`) and correlation ids (symbol/intent).
  - Cancellation (an exited intent's deadline timer must not fire).
  - Unit tests using the virtual clock only.
- Out of scope: opportunity finding (0130), the actual funding-schedule source (0190/0210), wall-clock integration tests.

## Implementation notes
Virtual clock invariants to test: timers fire in order even when `advanceTo` jumps past several; a timer registered during a fire (e.g. entry timer registered by the scan handler) still fires within the same advance if due; cancelled timers never fire. Keep the scheduler free of strategy knowledge — it schedules instants it is told, most-negative-first ordering lives in the finder (0130).

## Verification (definition of done)
1. `npm run verify` — green.
2. New unit tests demonstrate: advancing a virtual clock from `10:57` to `11:00` fires exactly one scan timer (`10:58:00`) and a registered entry timer (`10:59:57` for offset 3); cancellation works; ordering is deterministic across repeated runs (run the suite twice, identical results).
3. `grep -rn "setTimeout" test/` returns nothing (except any explicit real-clock adapter test file if one exists — none expected in this task).
