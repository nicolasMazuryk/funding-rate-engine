/**
 * Cross-cutting validations beyond single-field bounds (`09_configuration.md` §6).
 * The co-run guard reuses `checkCoRunGuard` directly (see `co-run-guard.ts`); these
 * are the remaining three checks. WS-mandatory and deadline-vs-timeout fail loud;
 * the sizing-feasibility check is a soft warn (the real per-symbol check is at
 * preflight, `12`, once instrument data exists).
 */

import { evaluateProfitCondition, type FeeInputs } from '../core/runtime/cost-model.js'
import type { StrategyId } from './canonical.js'
import { ConfigParseError } from './errors.js'
import type { ExchangeProfile } from './exchange-schema.js'

/** Strategies that place orders over the WS order adapter (`00_globals.md` §6). */
const WS_MANDATORY_STRATEGIES: readonly StrategyId[] = ['s1-ws', 's2', 's6']

/** Strategies where both `deadlineSeconds` and `fundingFeeTimeoutSeconds` apply. */
const DEADLINE_VS_TIMEOUT_STRATEGIES: readonly StrategyId[] = ['s2', 's6']

/**
 * Conservative soft-warn floor for `amount_usd` — not a fabricated per-venue
 * min-notional. The hard per-symbol check stays at preflight (`12`).
 */
export const SIZING_FEASIBILITY_MIN_NOTIONAL_USD_HINT = 5

/**
 * WS-mandatory guard: `s1-ws`/`s2`/`s6` require a WS order adapter, else throw at
 * startup. A profile that sets `ws_order_rest_fallback: true` is the only exception
 * (`00_globals.md` §6). Pure data: `profile.wsOrderAdapter || wsOrderRestFallback`.
 */
export function checkWsMandatoryGuard(
  strategyId: StrategyId,
  profile: ExchangeProfile,
  wsOrderRestFallback: boolean,
): void {
  if (!WS_MANDATORY_STRATEGIES.includes(strategyId)) return
  if (profile.wsOrderAdapter || wsOrderRestFallback) return
  throw new ConfigParseError(
    'ws_order_adapter',
    `strategy '${strategyId}' requires a WS order adapter (no ws_order_adapter and no ws_order_rest_fallback, 00_globals §6)`,
    'ws_order_adapter_required',
  )
}

/**
 * Deadline-vs-timeout sanity (§6, bounds §9.1): `deadline_seconds` must be
 * `>= funding_fee_timeout_seconds` where both apply (S2/S6).
 */
export function checkDeadlineVsTimeout(
  strategyParams: Readonly<Record<string, number | string>>,
  strategyId: StrategyId,
): void {
  if (!DEADLINE_VS_TIMEOUT_STRATEGIES.includes(strategyId)) return
  const deadline = strategyParams.deadlineSeconds
  const timeout = strategyParams.fundingFeeTimeoutSeconds
  if (typeof deadline !== 'number' || typeof timeout !== 'number') return
  if (deadline < timeout) {
    throw new ConfigParseError(
      'strategy_params.deadline_seconds',
      `deadline_seconds (${deadline}) must be >= funding_fee_timeout_seconds (${timeout}) (09 §6)`,
      'deadline_lt_timeout',
    )
  }
}

/**
 * Group-L strategies subject to the structural cost gate (`00_globals.md` §11-R10).
 * Their profit condition (`|F| > FEES`) is fully determined by the configured
 * threshold + fees, so an uneconomic config is rejectable at load time. Group S/R/D
 * TP-path economics are also config-deterministic but fail safe at selection
 * (advisory) instead — no untested arithmetic added here (YAGNI).
 */
const STRUCTURAL_COST_STRATEGIES: readonly StrategyId[] = ['s1', 's1-ws', 's2']

/**
 * Structural cost economics (`00_globals.md` §11-R10; `01_strategy_1.md` §4): a
 * Group-L `negative_funding_threshold_percent` too shallow to clear round-trip
 * fees can never net profit regardless of the realized drop — reject at load.
 * E.g. s1 threshold −0.1 vs taker 0.05% (fees 0.10%): `0.1 <= 0.10` → reject.
 */
export function checkStructuralCostEconomics(
  strategyParams: Readonly<Record<string, number | string>>,
  strategyId: StrategyId,
  fees: FeeInputs,
): void {
  if (!STRUCTURAL_COST_STRATEGIES.includes(strategyId)) return
  const threshold = strategyParams.negativeFundingThresholdPercent
  if (typeof threshold !== 'number') return
  const breakdown = evaluateProfitCondition(strategyId, { fundingRatePercent: threshold, fees, params: strategyParams })
  if (breakdown.passes) return
  throw new ConfigParseError(
    'strategy_params.negative_funding_threshold_percent',
    `strategy '${strategyId}' threshold ${threshold}% cannot structurally clear fees (|F|=${Math.abs(threshold)} <= FEES=${breakdown.feeTerm}); 00_globals §11-R10`,
    'uneconomic_structural_config',
  )
}

/**
 * Sizing feasibility hint (§6): warn if `amount_usd` is below the conservative
 * floor. Never throws — returns a warning string or `undefined`.
 */
export function checkSizingFeasibilityHint(
  sizing: Readonly<Record<string, number>>,
  strategyId: StrategyId,
): string | undefined {
  const amount = sizing.amountUsd ?? sizing.mainAmountUsd
  if (typeof amount !== 'number' || amount >= SIZING_FEASIBILITY_MIN_NOTIONAL_USD_HINT) return undefined
  return `sizing.amount_usd (${amount}) for '${strategyId}' is below the ${SIZING_FEASIBILITY_MIN_NOTIONAL_USD_HINT} USD feasibility hint; per-symbol min-notional is enforced at preflight (12)`
}
