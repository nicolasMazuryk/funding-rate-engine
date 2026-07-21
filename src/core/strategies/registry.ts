/**
 * Strategy registry — pure core (`08_system_overview.md` §5 Registry pattern;
 * `12_strategy_runtime_and_intent_lifecycle.md` §2).
 *
 * Dispatch to the active strategy is a map lookup, not a `switch` — new strategy
 * modules (`01`–`07`, tasks 0280+) register without touching the engine. Each
 * module is a pure selector: given an engine-filtered {@link Candidate} and the
 * runtime config, it returns a {@link StrategyTrigger} or declines. The three
 * strategy-agnostic guards (proximity / freshness / imminence) run *before*
 * `select` in the finder; the module only applies its own threshold rule.
 */

import type { StrategyId } from '../../config/canonical.js'
import type { ExitPolicyKind } from '../intent/exit-policy.js'
import type { FeeInputs } from '../runtime/cost-model.js'
import type { Candidate } from '../runtime/finder.js'

/** Exit-policy family a module uses. The kind union is owned by `exit-policy.ts` (single source of truth). */
export type { ExitPolicyKind }

/**
 * Engine-level runtime config passed to `select` and consumed by the engine
 * (`08` §5). A small explicit shape — not the full `EffectiveConfig` — so `core`
 * takes no dependency on `src/config` loading before `main.ts` exists.
 */
export interface RuntimeStrategyConfig {
  readonly id: StrategyId
  /** Selection threshold, signed percent (`00_globals.md` §1.2). */
  readonly thresholdPercent: number
  /** Which ordering family applies: `negative` most-negative-first, `positive` most-positive-first. */
  readonly direction: 'negative' | 'positive'
  /** Delay before `T_settle` at which the entry timer fires, seconds (`entry_offset_seconds`). */
  readonly entryOffsetSeconds: number
  /** Delay after `T_settle` at which the `timed` exit fires, seconds (`exit_offset_seconds`, S1). */
  readonly exitOffsetSeconds: number
  /** Fixed notional per intent, quote currency (`00_globals.md` §4); sized to a qty in the runtime (`00_globals.md` §4). */
  readonly amountUsd: number
  /** Balance-check divisor — required margin is `amountUsd / leverage` (`11` §7). */
  readonly leverage: number
  /** Fee inputs for the advisory cost-model gate (task 0150). Absent ⇒ no evaluation. */
  readonly costFees?: FeeInputs
  /** Strategy params the cost model reads (e.g. `tpVariantAMultiplier`, `takeProfitPct`). Absent ⇒ no evaluation. */
  readonly costParams?: Readonly<Record<string, number | string>>
}

/** A module's decision to act on a candidate: the symbol and the settlement it entered against. */
export interface StrategyTrigger {
  readonly symbol: string
  readonly settleTs: number
}

/** One strategy module: an id, its exit-policy family, and a pure selector. */
export interface StrategyModule {
  readonly id: StrategyId
  readonly exitPolicyKind: ExitPolicyKind
  /** Apply the module's own threshold rule to a guarded candidate; `undefined` declines. */
  select(candidate: Candidate, config: RuntimeStrategyConfig): StrategyTrigger | undefined
}

export type StrategyRegistry = ReadonlyMap<StrategyId, StrategyModule>

/** Build the registry from the modules; a duplicate id is a fail-loud startup error. */
export function createStrategyRegistry(modules: readonly StrategyModule[]): StrategyRegistry {
  const registry = new Map<StrategyId, StrategyModule>()
  for (const module of modules) {
    if (registry.has(module.id)) throw new Error(`StrategyRegistry: duplicate strategy id '${module.id}'`)
    registry.set(module.id, module)
  }
  return registry
}
