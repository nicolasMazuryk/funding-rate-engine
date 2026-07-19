/**
 * Cross-cutting validations beyond single-field bounds (`09_configuration.md` §6).
 * The co-run guard reuses `checkCoRunGuard` directly (see `co-run-guard.ts`); these
 * are the remaining three checks. WS-mandatory and deadline-vs-timeout fail loud;
 * the sizing-feasibility check is a soft warn (the real per-symbol check is at
 * preflight, `12`, once instrument data exists).
 */

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
