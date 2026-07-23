/**
 * Trivial in-memory `Repo` fake (task 0090) so golden / crash / unit tests run
 * without Docker/Postgres. Current-state projection only, keyed by `intentId`;
 * `loadNonTerminalIntents` filters via the FSM's `TERMINAL_INTENT_STATES` (single
 * source of truth). The Postgres integration test uses the real `createPgRepo`.
 *
 * Moved to `src/replay/` in task 0170 so the (non-test) skeleton composition root
 * can depend on it without importing test code; `test/helpers/in-memory-repo.ts`
 * re-exports it for existing test imports.
 */

import { TERMINAL_INTENT_STATES } from '../core/intent/intent-machine.js'
import type { IntentSnapshot, KillSwitchRecord, Repo, TrackerSnapshotRecord } from '../core/ports/index.js'

export interface InMemoryRepo extends Repo {
  /** All upserted snapshots, for assertions. */
  snapshots(): readonly IntentSnapshot[]
}

export function createInMemoryRepo(): InMemoryRepo {
  const byIntent = new Map<string, IntentSnapshot>()
  const terminal = new Set<string>(TERMINAL_INTENT_STATES)
  const trackerSnapshots = new Map<string, TrackerSnapshotRecord>()
  let killSwitchRow: KillSwitchRecord | undefined

  return {
    upsertIntentState(snapshot: IntentSnapshot): Promise<void> {
      byIntent.set(snapshot.intentId, snapshot)
      return Promise.resolve()
    },
    loadNonTerminalIntents(): Promise<readonly IntentSnapshot[]> {
      return Promise.resolve([...byIntent.values()].filter((s) => !terminal.has(s.state)))
    },
    upsertKillSwitch(record: KillSwitchRecord): Promise<void> {
      killSwitchRow = record
      return Promise.resolve()
    },
    loadKillSwitch(): Promise<KillSwitchRecord | undefined> {
      return Promise.resolve(killSwitchRow)
    },
    upsertTrackerSnapshot(snapshot: TrackerSnapshotRecord): Promise<void> {
      trackerSnapshots.set(snapshot.intentId, snapshot)
      return Promise.resolve()
    },
    loadTrackerSnapshots(): Promise<readonly TrackerSnapshotRecord[]> {
      return Promise.resolve([...trackerSnapshots.values()])
    },
    snapshots(): readonly IntentSnapshot[] {
      return [...byIntent.values()]
    },
  }
}
