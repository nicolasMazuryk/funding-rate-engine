/**
 * Scenario DSL (task 0160). A scenario is a plain data object — a name and a list of
 * timed actions — built fluently via `scenario(name).at(ts, action)`. `runScenario`
 * ({@link ./run-scenario.js}) sorts the steps by `ts`, advances the virtual clock to
 * each, and executes the action against a fresh {@link SkeletonHarness}. Because sim
 * fills / timers / fault delays all resolve synchronously through `clock.advanceTo`,
 * two runs from fresh state produce byte-identical traces (`0000` §5 determinism).
 *
 * Crash/restart is deliberately NOT a DSL action — it needs a fresh engine sharing the
 * WAL/clock/bus/venue, which {@link ./crash-helper.js} wraps directly (reusing the
 * proven `crash-recovery.test.ts` sequence).
 */

import type { EngineEvent } from '../../src/core/events/types.js'
import type { OrderRequest } from '../../src/core/ports/exchange-adapter.js'
import type { SkeletonHarness } from '../helpers/build-skeleton-engine.js'

/** One timed action in a scenario; `ts` is epoch-ms virtual-clock time. */
export type ScenarioAction =
  | { readonly kind: 'setPrice'; readonly symbol: string; readonly px: number }
  | { readonly kind: 'placeOrder'; readonly req: OrderRequest }
  | { readonly kind: 'fault'; readonly run: (h: SkeletonHarness) => void }
  | { readonly kind: 'assert'; readonly check: (h: SkeletonHarness, trace: readonly EngineEvent[]) => void }

export interface ScenarioStep {
  readonly ts: number
  readonly action: ScenarioAction
}

export interface Scenario {
  readonly name: string
  readonly steps: readonly ScenarioStep[]
}

export interface ScenarioBuilder {
  at(ts: number, action: ScenarioAction): ScenarioBuilder
  build(): Scenario
}

export function scenario(name: string): ScenarioBuilder {
  const steps: ScenarioStep[] = []
  const builder: ScenarioBuilder = {
    at(ts, action) {
      steps.push({ ts, action })
      return builder
    },
    build() {
      return { name, steps: [...steps] }
    },
  }
  return builder
}

// ── action constructors (readable call sites) ─────────────────────────────────
export const setPrice = (symbol: string, px: number): ScenarioAction => ({ kind: 'setPrice', symbol, px })
export const placeOrder = (req: OrderRequest): ScenarioAction => ({ kind: 'placeOrder', req })
export const fault = (run: (h: SkeletonHarness) => void): ScenarioAction => ({ kind: 'fault', run })
export const check = (fn: (h: SkeletonHarness, trace: readonly EngineEvent[]) => void): ScenarioAction => ({
  kind: 'assert',
  check: fn,
})
