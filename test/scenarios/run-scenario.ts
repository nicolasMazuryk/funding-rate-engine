/**
 * Scenario runner (task 0160). Wires a full {@link SkeletonHarness} (sim venue +
 * virtual clock + engine) via `buildSkeletonEngine`, taps the bus into an in-memory
 * trace, then for each step (sorted by `ts`) advances the clock and runs the action.
 *
 * The engine is present but inert for pure-venue scenarios: its scheduler is never
 * started, and it no-ops on `OrderUpdate`s for `clientOrderId`s it did not place
 * (`engine.ts` `onOrderUpdate`), so directly-placed orders exercise the sim without
 * engine interference. Determinism: everything resolves synchronously through
 * `clock.advanceTo`, so `runScenario` twice from fresh state ⇒ byte-identical `trace`.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EngineEvent } from '../../src/core/events/types.js'
import { buildSkeletonEngine, type SkeletonHarness } from '../helpers/build-skeleton-engine.js'
import type { Scenario, ScenarioAction } from './dsl.js'

export interface RunResult {
  readonly trace: readonly EngineEvent[]
  readonly harness: SkeletonHarness
  /** Dispose the engine, close the WAL, and remove the temp dir. */
  cleanup(): void
}

/** A disposable temp WAL path for a scenario/unit test. */
export function tempWalPath(prefix = 'scenario-'): { walPath: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { walPath: join(dir, 'instance.wal.jsonl'), dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

export function runScenario(scn: Scenario, opts: { startMs?: number } = {}): RunResult {
  const tmp = tempWalPath()
  const harness = buildSkeletonEngine({ walPath: tmp.walPath, startMs: opts.startMs })
  const trace: EngineEvent[] = []
  harness.bus.subscribe((e) => trace.push(e))

  // Stable sort by ts (index tie-break) so equal-ts steps keep declaration order.
  const ordered = [...scn.steps].map((step, i) => ({ step, i })).sort((a, b) => a.step.ts - b.step.ts || a.i - b.i)

  for (const { step } of ordered) {
    harness.clock.advanceTo(step.ts)
    execute(step.action, harness, trace)
  }

  return {
    trace,
    harness,
    cleanup() {
      harness.engine.dispose()
      harness.wal.close()
      tmp.dispose()
    },
  }
}

function execute(action: ScenarioAction, h: SkeletonHarness, trace: readonly EngineEvent[]): void {
  switch (action.kind) {
    case 'setPrice':
      h.exchange.setPrice(action.symbol, action.px)
      return
    case 'placeOrder':
      void h.exchange.placeOrder(action.req) // synchronous side effects captured in the trace
      return
    case 'fault':
      action.run(h)
      return
    case 'assert':
      action.check(h, trace)
      return
  }
}
