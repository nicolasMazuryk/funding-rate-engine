/**
 * Preflight — the fail-fast choke point evaluated before any venue write
 * (`12_strategy_runtime_and_intent_lifecycle.md` §3; kill switch `13` §2 /
 * `00_globals.md` §5.1; risk gate `13` §1).
 *
 * Pure and synchronous: given a {@link PreflightSnapshot} (the engine's current
 * view of kill switch, risk state, balance, price, instrument, account setup and
 * market status) it returns one of three verdicts. The distinction is load-bearing
 * (`12` §3, `13` §6): some failures **reject** an already-selected intent
 * (`ABORTED` + `error_code`, WAL-logged), others **skip** the symbol entirely (no
 * intent row at all). The checks run in the exact `12` §3 order, short-circuiting
 * on the first failure — so a paused kill switch always wins over a later balance
 * failure.
 *
 * Fail-closed: an unknown balance (`undefined`) rejects; an unknown price
 * (`undefined`) skips — consistent with the fail-loud rule (never trade on a
 * silently-zeroed price/balance).
 */

import type { KillSwitchState } from '../../config/env.js'
import type { ErrorCode } from '../intent/intent-machine.js'
import type { Balance, Instrument, MarketStatus } from '../ports/exchange-adapter.js'
import type { RiskGate } from '../ports/risk-gate.js'
import { checkFeasibility } from '../sizing/sizing.js'

/** The engine's current view fed into {@link runPreflight}; every field is a plain value (no I/O). */
export interface PreflightSnapshot {
  readonly killSwitch: KillSwitchState
  /** Live (non-terminal) intents already tracked by the engine — the risk gate's concurrency input. */
  readonly openIntentCount: number
  /** Circuit-breaker state; stub `false` until breakers land (0380). */
  readonly breakerOpen: boolean
  /** Fixed notional per intent, quote currency (`00_globals.md` §4). */
  readonly amountUsd: number
  /** Balance-check divisor (`11` §7). */
  readonly leverage: number
  /** Latest known balance; `undefined` = unknown → fails closed (reject). */
  readonly balance: Balance | undefined
  /** Order quantity, base units (fixed skeleton qty; real sizing 0280). */
  readonly qty: number
  /** Latest mark price; `undefined` = unknown → fails closed (skip). */
  readonly price: number | undefined
  readonly instrument: Instrument
  /** Leverage/margin-mode setup done in advance (`11` §1); real producer 0240. */
  readonly accountSetupComplete: boolean
  readonly marketStatus: MarketStatus
}

/**
 * A preflight verdict (`12` §3, `13` §6): `pass` proceeds to entry; `reject`
 * aborts the selected intent with an `errorCode`; `skip` drops the symbol with no
 * intent row.
 */
export type PreflightResult =
  | { readonly kind: 'pass' }
  | { readonly kind: 'reject'; readonly errorCode: ErrorCode }
  | { readonly kind: 'skip' }

/**
 * Run the ordered preflight checks (`12` §3) against `snapshot`. First failure
 * wins (short-circuit), so ordering is observable: e.g. a paused kill switch
 * rejects with `kill_switch` even if the balance would also fail.
 */
export function runPreflight(snapshot: PreflightSnapshot, riskGate: RiskGate, symbol: string): PreflightResult {
  // 1. Kill switch — `!= off` rejects every new intent (`13` §2 / `00_globals.md` §5.1).
  if (snapshot.killSwitch !== 'off') return { kind: 'reject', errorCode: 'kill_switch' }

  // 2. Risk gate — concurrency / notional / breaker (`13` §1).
  const decision = riskGate.check(
    { symbol, amountUsd: snapshot.amountUsd },
    { openIntentCount: snapshot.openIntentCount, breakerOpen: snapshot.breakerOpen },
  )
  if (!decision.allowed) return { kind: 'reject', errorCode: decision.code ?? 'risk_breaker_open' }

  // 3. Balance — unknown (fail-closed) or below required margin rejects.
  if (snapshot.balance === undefined || snapshot.balance.free < snapshot.amountUsd / snapshot.leverage) {
    return { kind: 'reject', errorCode: 'insufficient_balance' }
  }

  // 4. Price + feasibility — unknown price fails closed (skip); infeasible order skips.
  if (snapshot.price === undefined) return { kind: 'skip' }
  if (!checkFeasibility(snapshot.qty, snapshot.price, snapshot.instrument).ok) return { kind: 'skip' }

  // 5. Account setup — leverage/margin-mode must be set in advance (`11` §1).
  if (!snapshot.accountSetupComplete) return { kind: 'reject', errorCode: 'account_setup_incomplete' }

  // 6. Market status — non-trading symbols are skipped, not aborted (`12` §3).
  if (snapshot.marketStatus !== 'trading') return { kind: 'skip' }

  return { kind: 'pass' }
}
