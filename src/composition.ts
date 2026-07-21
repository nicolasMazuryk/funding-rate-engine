/**
 * Composition helpers (task 0280) — the shared engine wiring extracted so both
 * `main.ts` (live run) and the test harness (`build-skeleton-harness.ts`) resolve
 * the same strategy + exit-policy registries. 0270 deferred this extract to here.
 *
 * Two seams:
 *  - {@link runtimeConfigFromEffective}: the `EffectiveConfig` → engine-facing
 *    {@link RuntimeStrategyConfig} projection (`strategyParams`/`sizing`/profile fees).
 *  - {@link wireS1Engine}: build the engine given concrete ports, registering the S1
 *    module + the real `timed` handler.
 *
 * This is impure only by association — it imports no I/O; the caller supplies the
 * ports. It sits outside `src/core/` because it references `src/config`.
 */

import type { EffectiveConfig } from './config/effective-config.js'
import { TIMED_HANDLER } from './core/intent/exit-policies/timed.js'
import { createExitPolicyRegistry } from './core/intent/exit-policy.js'
import type { EngineDeps } from './core/runtime/engine.js'
import { createEngine, type Engine } from './core/runtime/engine.js'
import { createStrategyRegistry, type RuntimeStrategyConfig } from './core/strategies/registry.js'
import { createStrategy1 } from './core/strategies/strategy-1.js'

/** Read a numeric strategy param or fail loud — a missing/non-numeric key is a config bug. */
function numberParam(params: Readonly<Record<string, number | string>>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number') throw new Error(`composition: strategy param '${key}' is not a number (${value})`)
  return value
}

/** Read a numeric sizing field or fail loud — a missing key is a config bug (`09` §5 validated it). */
function sizingField(sizing: Readonly<Record<string, number>>, key: string): number {
  const value = sizing[key]
  if (typeof value !== 'number') throw new Error(`composition: sizing field '${key}' is missing`)
  return value
}

/**
 * Project the frozen {@link EffectiveConfig} into the engine-facing
 * {@link RuntimeStrategyConfig}. S1's shape (`01` §5): negative-funding threshold,
 * entry/exit offsets, USD sizing + leverage, and the profile fees the advisory
 * cost model reads (`00_globals.md` §1.1).
 */
export function runtimeConfigFromEffective(cfg: EffectiveConfig): RuntimeStrategyConfig {
  const params = cfg.strategyParams
  return {
    id: cfg.strategy,
    thresholdPercent: numberParam(params, 'negativeFundingThresholdPercent'),
    direction: 'negative',
    entryOffsetSeconds: numberParam(params, 'entryOffsetSeconds'),
    exitOffsetSeconds: numberParam(params, 'exitOffsetSeconds'),
    amountUsd: sizingField(cfg.sizing, 'amountUsd'),
    leverage: sizingField(cfg.sizing, 'leverage'),
    costFees: { takerFeePct: cfg.exchangeProfile.takerFeePct, makerFeePct: cfg.exchangeProfile.makerFeePct },
    costParams: params,
  }
}

/** The engine deps a caller supplies; the S1 registry + exit-policy registry are wired here. */
export type S1EngineDeps = Omit<EngineDeps, 'registry' | 'exitPolicyRegistry'>

/** Wire the engine with the S1 strategy module and the real `timed` exit handler. */
export function wireS1Engine(deps: S1EngineDeps): Engine {
  return createEngine({
    ...deps,
    registry: createStrategyRegistry([createStrategy1()]),
    exitPolicyRegistry: createExitPolicyRegistry([TIMED_HANDLER]),
  })
}
