/**
 * Instrument-validation hook (`09_configuration.md` §5 step 6): the last startup
 * step validates instruments/precision against a live client (`10` §4). That needs
 * an adapter, which does not exist yet — so this is a type declaration only, wired
 * and invoked by task 0190. Declared here to fix the pipeline's final seam now.
 */

import type { ExchangeAdapter } from '../core/ports/exchange-adapter.js'
import type { EffectiveConfig } from './effective-config.js'

export interface InstrumentValidationHook {
  validate(config: EffectiveConfig): Promise<void>
}

/**
 * Concrete hook (task 0190): validation is exactly the adapter's fail-loud `init()`
 * — it loads markets and builds the validated `Instrument` registry, throwing on any
 * anomaly (`10` §4). A bad instrument therefore aborts startup at `09` §5 step 6,
 * before any order. Depends only on the {@link ExchangeAdapter} port, so any venue's
 * adapter drops in. Not wired into a composition root yet (no `main.ts`).
 */
export function createInstrumentValidationHook(adapter: ExchangeAdapter): InstrumentValidationHook {
  return {
    validate(_config: EffectiveConfig): Promise<void> {
      return adapter.init()
    },
  }
}
