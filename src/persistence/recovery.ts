/**
 * Full crash recovery — the deterministic boot sequence (`14_persistence_and_recovery.md`
 * §5, task 0370). Lives outside `src/core/` (it touches the `Repo`/`WalFile`/`Pool` ports
 * directly), but only ever calls `engine.recover(...)` on the pure core — the core stays
 * payload-opaque to how it got rebuilt.
 *
 * Five steps, in order, each gating the next:
 *  1. **Config-hash check** — every persisted non-terminal intent's `configHash` must match
 *     the current boot's `revisionHash` (`09` §7). A mismatch fails loud *before any venue
 *     call*: resuming in-flight intents against a changed config is a live-order bug, not a
 *     warning.
 *  2. **Replay the WAL** — the local file first (ground truth for anything not yet
 *     forwarded), then the Postgres `intent_wal` shipped history for this instance (ground
 *     truth for anything the local file lost), merged by `seq` (the same monotonic numbering
 *     the forwarder copies verbatim) so `recoveredFromWal` folds to the true last transition
 *     per intent regardless of which side has it.
 *  3. **Load tracker snapshots** — the durable per-intent handler state (S2's retracement
 *     tracker; decision #2, `docs/plan/tasks/0370*.md`).
 *  4. **`engine.recover`** — per-intent REST reconcile + resolve, the pure-core surface.
 *  5. **Restore the kill switch** — replay the persisted state through the existing
 *     `KillSwitch.transition` (no-op if it already matches the constructor's initial state).
 *
 * The caller (`main.ts`) runs this between building the engine and `scheduler.start()` —
 * recovery must finish before the live event stream (scan/entry timers, market ticks) starts
 * driving the engine.
 */

import { drizzle } from 'drizzle-orm/node-postgres'
import type { Pool } from 'pg'
import type { KillSwitchState } from '../config/env.js'
import type { Repo } from '../core/ports/repo.js'
import { type Engine, recoveredFromWal } from '../core/runtime/engine.js'
import type { KillSwitch } from '../risk/kill-switch.js'
import type { Instance } from './db/instance.js'
import { instanceWhere, intentWal } from './db/schema.js'
import type { WalFile, WalRecord } from './wal/wal-file.js'

export interface RecoveryDeps {
  readonly repo: Repo
  readonly wal: WalFile
  readonly engine: Engine
  readonly killSwitch: KillSwitch
  /** This boot's config revision hash (`09` §7) — compared against every persisted intent's. */
  readonly configHash: string
  readonly instance: Instance
  /**
   * Read access to the shipped Postgres `intent_wal` history (step 2's second source).
   * Absent in tests that only exercise the local-WAL path (the in-memory repo has no
   * backing Postgres table to read).
   */
  readonly pool?: Pool
}

/** Read this instance's forwarded `intent_wal` rows, oldest first, shaped as `WalRecord`s. */
async function loadForwardedWal(pool: Pool, instance: Instance): Promise<readonly WalRecord[]> {
  const db = drizzle(pool)
  const rows = await db.select().from(intentWal).where(instanceWhere(intentWal, instance)).orderBy(intentWal.seq)
  return rows.map((r) => ({
    seq: r.seq,
    ts: r.ts,
    intentId: r.intentId,
    fromState: r.fromState,
    toState: r.toState,
    payload: r.payload,
    clientOrderId: r.clientOrderId ?? undefined,
  }))
}

/** Merge local + forwarded WAL records by `seq` ascending — the shared monotonic numbering. */
function mergeWalRecords(local: readonly WalRecord[], remote: readonly WalRecord[]): readonly WalRecord[] {
  return [...local, ...remote].sort((a, b) => a.seq - b.seq)
}

/** Fail-loud config-hash guard (`09` §7): a mismatch aborts before any venue call. */
function assertConfigHashMatch(
  persisted: readonly { intentId: string; configHash?: string }[],
  configHash: string,
): void {
  for (const intent of persisted) {
    if (intent.configHash === undefined || intent.configHash === configHash) continue
    throw new Error(
      `recovery: config revision mismatch for intent '${intent.intentId}' ` +
        `(persisted '${intent.configHash}', current '${configHash}') — refusing to resume in-flight ` +
        `intents against a changed config ('09' §7). Resolve the drift (or flatten manually) before restarting.`,
    )
  }
}

/** Run the full 5-step boot recovery sequence. Throws (fail-loud) on a config-hash mismatch. */
export async function recoverOnBoot(deps: RecoveryDeps): Promise<void> {
  const { repo, wal, engine, killSwitch, configHash, instance, pool } = deps

  // 1. Config-hash check, before any venue call.
  const persisted = await repo.loadNonTerminalIntents()
  assertConfigHashMatch(persisted, configHash)

  // 2. Replay the WAL: local file + (if reachable) the Postgres shipped history, merged.
  const localRecords = wal.readAll()
  const remoteRecords = pool === undefined ? [] : await loadForwardedWal(pool, instance)
  const recovered = recoveredFromWal(mergeWalRecords(localRecords, remoteRecords))

  // 3. Tracker snapshots (optional writer/reader — only the Postgres repo implements it live).
  const snapshots = (await repo.loadTrackerSnapshots?.()) ?? []

  // 4. Per-intent REST reconcile + resolve — the pure-core surface.
  await engine.recover(recovered, snapshots)

  // 5. Restore the kill switch (no-op if it already matches the constructor's initial state).
  const persistedKillSwitch = await repo.loadKillSwitch?.()
  if (persistedKillSwitch !== undefined) {
    killSwitch.transition(persistedKillSwitch.state as KillSwitchState, persistedKillSwitch.reason)
  }
}
