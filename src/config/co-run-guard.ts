/**
 * Cross-container co-run guard (`00_globals.md` §9.1, `09_configuration.md` §6):
 * `s3a` (pre-settlement SHORT) must not run alongside any LONG strategy in the
 * same container — a SHORT and a LONG on the same funding event fight each other.
 * `s6` is direction-configurable, so it is exempt (absent from the LONG list).
 *
 * Pure check on already-parsed instance descriptors. Not wired into any multi-file
 * loader — that composition is task 0110's job.
 */

import { LONG_STRATEGY_IDS, type StrategyId } from './canonical.js'
import { ConfigParseError } from './errors.js'

export interface CoRunDescriptor {
  readonly strategyId: StrategyId
  readonly enabled: boolean
}

export function checkCoRunGuard(instances: readonly CoRunDescriptor[]): void {
  const enabled = new Set(instances.filter((i) => i.enabled).map((i) => i.strategyId))
  if (!enabled.has('s3a')) return

  const conflicts = LONG_STRATEGY_IDS.filter((id) => enabled.has(id))
  if (conflicts.length > 0) {
    throw new ConfigParseError(
      'co-run',
      `strategy 's3a' (SHORT) cannot run alongside LONG strategies: ${conflicts.join(', ')}`,
      's3a_co_run',
    )
  }
}
