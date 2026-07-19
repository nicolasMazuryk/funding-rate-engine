/**
 * Instrument-validation hook (`09_configuration.md` §5 step 6): the last startup
 * step validates instruments/precision against a live client (`10` §4). That needs
 * an adapter, which does not exist yet — so this is a type declaration only, wired
 * and invoked by task 0190. Declared here to fix the pipeline's final seam now.
 */

import type { EffectiveConfig } from './effective-config.js'

export interface InstrumentValidationHook {
  validate(config: EffectiveConfig): Promise<void>
}
