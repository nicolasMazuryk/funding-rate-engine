# 0070 — Local append-only WAL

**Phase:** 1 — Walking skeleton
**Depends on:** 0040
**Spec references:** `14_persistence_and_recovery.md` §2 (WAL), §2.1 (two-tier write path — the local tier); `11_execution_and_account_state.md` §4 (clientOrderId written before submission); `08_system_overview.md` §8 (WAL gates the side effect)

## Objective
The local, on-box, fsync'd append-only WAL file that gates every side effect: `append(transition)` durably writes `{ ts, intentId, fromState, toState, payload, clientOrderId? }` before the caller proceeds, and a reader replays the file in order. This is the recovery source of truth and the binding ordering commit point (`14` §2.1 step 1).

## Context for the agent
Two-tier design: this task is tier 1 (local file) only — the background forwarder to Postgres is 0080. The binding rule: a WAL entry is durably committed **before** the side effect it authorizes. Wire it to the FSM engine's `onTransition` hook (0040) so intent transitions cannot bypass it. Lives in `src/persistence/wal/` (impure — file I/O; core sees it only through the `Repo`/WAL port).

## Scope
- In scope:
  - `src/persistence/wal/wal-file.ts`: append-only JSONL, `fsync` per append, one file per instance (path from an options object; instance identity wiring comes with config in 0110), monotonic sequence numbers.
  - Reader: `readAll()` / iterate — tolerates a torn final line (crash mid-write): the incomplete last record is discarded with a warning, never a crash.
  - A `TransitionLog` port in `src/core/ports/` that the intent machine's observer calls; the WAL implements it.
  - Unit tests including a simulated torn write (truncate the file mid-record, reread).
- Out of scope: Postgres forwarder (0080), full recovery sequence (0370), retention/rotation (explicitly not needed — `14` §2 KISS).

## Implementation notes
JSONL keeps the reader trivial and the trace human-greppable. Use `fs.fsyncSync` (or `fdatasync`) on the open fd per append — sub-millisecond at this write rate (`14` §2: a handful of intents per hour). The append API must be synchronous-before-return from the caller's perspective (async function that resolves only after fsync is fine). Sequence numbers let 0080 track "unshipped" entries — include `seq` in the record now.

## Verification (definition of done)
1. `npm run verify` — green.
2. Unit tests: append N transitions → `readAll()` returns them in order with contiguous `seq`; torn-final-line file reads back N−1 records without throwing; an intent-machine transition with the WAL observer attached produces a WAL record before the observer's post-commit callback runs (order asserted).
3. Round-trip: a written record parses back deep-equal to the input.
