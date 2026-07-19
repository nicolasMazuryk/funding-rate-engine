/**
 * Trivial in-memory `Repo` fake (task 0090) so golden / crash / unit tests run
 * without Docker/Postgres. Current-state projection only, keyed by `intentId`;
 * `loadNonTerminalIntents` filters via the FSM's `TERMINAL_INTENT_STATES` (single
 * source of truth). The Postgres integration test uses the real `createPgRepo`.
 */

import { TERMINAL_INTENT_STATES } from '../../src/core/intent/intent-machine.js'
import type { IntentSnapshot, Repo } from '../../src/core/ports/index.js'

export interface InMemoryRepo extends Repo {
  /** All upserted snapshots, for assertions. */
  snapshots(): readonly IntentSnapshot[]
}

export function createInMemoryRepo(): InMemoryRepo {
  const byIntent = new Map<string, IntentSnapshot>()
  const terminal = new Set<string>(TERMINAL_INTENT_STATES)

  return {
    upsertIntentState(snapshot: IntentSnapshot): Promise<void> {
      byIntent.set(snapshot.intentId, snapshot)
      return Promise.resolve()
    },
    loadNonTerminalIntents(): Promise<readonly IntentSnapshot[]> {
      return Promise.resolve([...byIntent.values()].filter((s) => !terminal.has(s.state)))
    },
    snapshots(): readonly IntentSnapshot[] {
      return [...byIntent.values()]
    },
  }
}
