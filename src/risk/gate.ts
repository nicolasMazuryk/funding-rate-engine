/**
 * The concrete {@link RiskGate} (`13_risk_and_failure_modes.md` §1) — a single,
 * data-driven gate evaluated in preflight (`12` §3) before any venue write.
 * Lives outside `src/core/` (implements a core port from the edge, like the
 * adapters) so the pure core depends only on the interface.
 *
 * Checks run in a fixed order and short-circuit on the first breach:
 * concurrency, then notional, then breaker. `max_daily_loss_usd` from the
 * `config.risk` schema is deliberately **not** enforced here — it needs realized
 * P&L accounting that is not wired to the engine yet (out of scope; STATUS note).
 */

import type { RiskContext, RiskDecision, RiskGate, RiskIntent } from '../core/ports/risk-gate.js'

/** The risk limits the gate enforces (`13` §1 `config.risk` subset). */
export interface RiskLimits {
  /** Max simultaneously-live intents (`risk_max_concurrent_intents`). */
  readonly maxConcurrentIntents: number
  /** Max notional per intent, quote currency (`risk_max_notional_usd`). */
  readonly maxNotionalUsd: number
}

export function createRiskGate(limits: RiskLimits): RiskGate {
  return {
    check(intent: RiskIntent, context: RiskContext): RiskDecision {
      if (context.openIntentCount >= limits.maxConcurrentIntents) {
        return { allowed: false, code: 'risk_max_concurrent_intents' }
      }
      if (intent.amountUsd > limits.maxNotionalUsd) {
        return { allowed: false, code: 'risk_max_notional_usd' }
      }
      if (context.breakerOpen) {
        return { allowed: false, code: 'risk_breaker_open' }
      }
      return { allowed: true }
    },
  }
}
