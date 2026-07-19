/**
 * `RiskGate` port (`08_system_overview.md` §5; `13_risk_and_failure_modes.md` §1).
 *
 * Risk is a **single gate** evaluated in preflight (`12` §3) before any venue
 * write: concurrency, notional, daily-loss, breaker-open, kill switch. Centralized
 * (one gate) and data-driven (limits in `config.risk`), so every strategy inherits
 * identical checks and risk stays auditable in one place.
 *
 * The concrete gate lives in `src/risk/gate.ts` (0140); breakers land in 0380.
 */

import type { ErrorCode } from '../intent/intent-machine.js'

/** The subset of an intent the gate inspects. */
export interface RiskIntent {
  readonly symbol: string
  /** Fixed notional per intent, quote currency (`00_globals.md` §4). */
  readonly amountUsd: number
}

/** Engine-level state the gate weighs alongside the intent (`12` §3 / `13` §1). */
export interface RiskContext {
  /** Live (non-terminal) intents already open — concurrency-limit input. */
  readonly openIntentCount: number
  /** Circuit-breaker state (stub `false` until 0380). */
  readonly breakerOpen: boolean
}

/** The gate's verdict. On reject, `code` is the `00_globals.md` §10.2 error code. */
export interface RiskDecision {
  readonly allowed: boolean
  /** Error code when `allowed` is `false`. */
  readonly code?: ErrorCode
}

export interface RiskGate {
  /** Synchronous, side-effect-free verdict for one intent (`12` §3). */
  check(intent: RiskIntent, context: RiskContext): RiskDecision
}
