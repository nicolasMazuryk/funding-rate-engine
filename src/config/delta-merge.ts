/**
 * Apply per-exchange deltas (`00_globals.md` §6, `09_configuration.md` §4) onto an
 * already-validated strategy config. Only a field the strategy actually consumes is
 * overridden; the specific overridden value is re-bound-checked against its
 * canonical bound (a delta can never push a value out of range silently). A delta
 * on a field this strategy doesn't have is a no-op.
 */

import { boundViolation } from './bound-check.js'
import { boundFor, type CanonicalParam, paramsFor, type StrategyId } from './canonical.js'
import { ConfigParseError } from './errors.js'
import type { ExchangeProfile } from './exchange-schema.js'
import type { ParsedStrategyConfig } from './parse-strategy-config.js'

export interface DeltaMergeResult {
  readonly sizing: Readonly<Record<string, number>>
  readonly strategyParams: Readonly<Record<string, number | string>>
  readonly wsOrderRestFallback: boolean
  readonly warnings: readonly string[]
}

/** Find the canonical row a delta targets, or `undefined` if this strategy lacks it. */
function rowFor(
  yamlKey: string,
  strategyId: StrategyId,
  container: CanonicalParam['container'],
): CanonicalParam | undefined {
  return paramsFor(strategyId, container).find((p) => p.yamlKey === yamlKey)
}

/** Bound-check one overridden numeric value; throw `delta_out_of_bounds` on violation. */
function checkDelta(param: CanonicalParam, strategyId: StrategyId, value: number): void {
  const violation = boundViolation(value, boundFor(param, strategyId))
  if (violation !== undefined) {
    throw new ConfigParseError(
      `deltas.${param.yamlKey}`,
      `exchange delta ${violation} (00_globals §9.1)`,
      'delta_out_of_bounds',
    )
  }
}

export function applyExchangeDeltas(
  parsed: ParsedStrategyConfig,
  profile: ExchangeProfile,
  strategyId: StrategyId,
): DeltaMergeResult {
  const strategyParams: Record<string, number | string> = { ...parsed.strategyParams }
  const sizing: Record<string, number> = { ...parsed.sizing }
  const { deltas } = profile

  if (deltas.fundingFeeTimeoutSeconds !== undefined) {
    const row = rowFor('funding_fee_timeout_seconds', strategyId, 'strategy_params')
    if (row !== undefined) {
      checkDelta(row, strategyId, deltas.fundingFeeTimeoutSeconds)
      strategyParams[row.liveKey] = deltas.fundingFeeTimeoutSeconds
    }
  }

  const leverageOverride = deltas.leverage?.[strategyId]
  if (leverageOverride !== undefined) {
    const row = rowFor('leverage', strategyId, 'sizing')
    if (row !== undefined) {
      checkDelta(row, strategyId, leverageOverride)
      sizing[row.liveKey] = leverageOverride
    }
  }

  return {
    sizing,
    strategyParams,
    wsOrderRestFallback: deltas.wsOrderRestFallback ?? false,
    warnings: [],
  }
}
