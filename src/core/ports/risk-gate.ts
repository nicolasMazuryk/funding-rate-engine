/**
 * `RiskGate` port (`08_system_overview.md` §5; `13_risk_and_failure_modes.md` §1).
 *
 * Risk is a **single gate** evaluated in preflight (`12` §3) before any venue
 * write: concurrency, notional, daily-loss, breaker-open, kill switch. Centralized
 * (one gate) and data-driven (limits in `config.risk`), so every strategy inherits
 * identical checks and risk stays auditable in one place.
 *
 * PLACEHOLDER: `RiskIntent` is the minimal shape the gate reads today. The intent
 * FSM (0040) owns the full intent type; the concrete gate + breakers land in 0140.
 */

/** The subset of an intent the gate inspects. Placeholder — sharpened by 0040/0140. */
export interface RiskIntent {
  readonly symbol: string
  /** Fixed notional per intent, quote currency (`00_globals.md` §4). */
  readonly amountUsd: number
}

/** The gate's verdict. On reject, `code` maps to `00_globals.md` §10.2 error codes. */
export interface RiskDecision {
  readonly allowed: boolean
  /** Error code when `allowed` is `false` (e.g. `kill_switch`, `max_concurrent_intents`). */
  readonly code?: string
}

export interface RiskGate {
  /** Synchronous, side-effect-free verdict for one intent (`12` §3). */
  check(intent: RiskIntent): RiskDecision
}
