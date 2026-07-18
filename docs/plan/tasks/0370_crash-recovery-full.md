# 0370 — Full crash recovery + WAL forwarder robustness

**Phase:** 5 — Sidecars full
**Depends on:** 0240, 0310, 0360
**Spec references:** `14_persistence_and_recovery.md` §5 (crash recovery sequence), §2.1 (forwarder), §1 (what survives); `17_testing.md` §4 (crash recovery from every WAL state); `09_configuration.md` §7 (config hash check)

## Objective
The complete deterministic boot sequence from `14` §5: load config + verify config hash against persisted in-flight intents → replay local WAL then Postgres `intent_wal` → reconstruct in-memory FSM state of non-terminal intents → reconcile against venue REST ground truth (open orders by `clientOrderId`, positions, balances, funding history) → resolve every in-flight intent (adopt venue-confirmed orders, resubmit-or-abort WAL-only orders, orphan positions flagged, S2 tracker re-spawned) → restore kill-switch state → resume scheduling. Verified by crash e2e tests at **every** WAL state.

## Context for the agent
The skeleton (0090) proved two states; this task completes the matrix: crash after each intent-FSM WAL append point — `SELECTED`, `SUBMITTING_ENTRY` (pre-submit and post-submit-pre-ack), `MONITORING` (incl. armed funding gate and S2 mid-trailing), `EXITING` (exit order in flight), plus the unforwarded-WAL case (local entries not yet in Postgres — local file wins, re-forward idempotently). Resolution rules (`14` §5 step 4): order filled on venue but WAL didn't record → adopt, advance FSM; order in WAL but not on venue → re-submit (idempotent by `clientOrderId`) or abort; venue position with no intent → orphan (auto-flatten backstop is 0380 — emit the event); S2 tracker state present → re-spawn (0310 built serialize/restore; wire it here). Recovery is deterministic: WAL + venue truth fully determine the next action — no guesswork, no double-execution.

## Scope
- In scope:
  - `src/persistence/recovery.ts`: the 5-step boot sequence, integrated into `main.ts`/composition before scheduling resumes.
  - Config-hash check: persisted in-flight intent with a different config hash → fail-loud with a clear operator message (config changed mid-flight is an operational error, `09` §7).
  - Forwarder hardening: idempotent catch-up after arbitrary downtime, watermark correctness across restarts, bounded batch sizes, error backoff (0080's minimal version productionized).
  - Crash e2e matrix: harness helper `crashAt(walPoint)` that boots, runs a scenario to the target WAL state, discards the process state, re-boots through recovery, and asserts: deterministic terminal outcome, no duplicate venue orders (sim order history), no lost fills, S2 tracker resumes trailing from persisted `P_low`.
  - Duplicate-recovery test: recover, crash during recovery, recover again → same outcome (recovery itself is idempotent).
- Out of scope: orphan auto-flatten action (0380), reconciliation records (0400).

## Implementation notes
Drive the matrix from the intent-FSM transition table itself (iterate all WAL-append points programmatically) so a future FSM change automatically extends the matrix — this is the "every WAL state" requirement made mechanical. The adopt-vs-resubmit decision needs the order manager's `findByClientOrderId` (0230). Sim support: the sim venue must survive an engine "restart" with its state intact (venue-side truth persists across the crash boundary) — extend the harness if needed.

## Verification (definition of done)
1. `npm run verify` + `npm run test:e2e` — green; the crash matrix reports one passing test per WAL-append point (enumerated in output).
2. No-double-submit proof: across the whole matrix, sim venue order history contains no duplicate `clientOrderId` submissions.
3. Unforwarded-WAL crash: local entries present, Postgres behind → after recovery, `intent_wal` catches up exactly once (row-count assert).
4. Config-hash mismatch test: boot with altered config over an in-flight intent → fail-loud, no venue calls.
5. Recovery-idempotency test passes.
