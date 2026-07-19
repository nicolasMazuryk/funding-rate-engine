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
import type { IntentSnapshot, Repo } from '../core/ports/index.js'

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
