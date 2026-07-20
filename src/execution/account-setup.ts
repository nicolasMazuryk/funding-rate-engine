/**
 * Venue-neutral account setup (`11_execution_and_account_state.md` §1;
 * `00_globals.md` §4 hard-reject). Runs the `11` §1 setup **once in advance** through
 * the `ExchangeAdapter` port: one account-wide `setPositionMode('one_way')`, then per
 * symbol `setMarginMode('isolated')` + `setLeverage(effective)`. A throw on any symbol's
 * margin/leverage marks **that symbol untradable** (hard reject → preflight rejects the
 * intent with `account_setup_incomplete`); a `setPositionMode` throw is account-wide, so
 * **no** symbol trades.
 *
 * The idempotency cache lives at the adapter (`binance/account-setup.ts`, `11` §1);
 * this layer owns only orchestration + the per-symbol readiness verdict. Purely against
 * the port, so it runs against the sim → the preflight-reject path is testable with zero
 * credentials.
 */

import type { ExchangeAdapter } from '../core/ports/exchange-adapter.js'

/** The narrow port slice account setup drives — no order/stream methods needed. */
export type AccountSetupExchange = Pick<ExchangeAdapter, 'setPositionMode' | 'setMarginMode' | 'setLeverage'>

/** Per-symbol readiness gate consumed by the engine preflight (`accountSetupComplete`). */
export interface AccountSetupResult {
  /** `true` iff position mode, isolated margin, and leverage all applied for `symbol`. */
  isReady(symbol: string): boolean
}

/** Optional structured-log sink; a setup failure is logged, never thrown out of `runAccountSetup`. */
export type AccountSetupLog = (message: string, meta?: Record<string, unknown>) => void

/**
 * Apply account setup for every `symbols` entry. `leverageFor` supplies the effective
 * (delta-resolved, `00_globals` §6) leverage per symbol. Returns a readiness gate; a
 * throw never escapes — it downgrades the affected symbol(s) to not-ready (hard reject).
 */
export async function runAccountSetup(
  exchange: AccountSetupExchange,
  symbols: readonly string[],
  leverageFor: (symbol: string) => number,
  log?: AccountSetupLog,
): Promise<AccountSetupResult> {
  const ready = new Set<string>()

  // Position mode is account-wide (`11` §1): if it fails, nothing trades safely.
  try {
    await exchange.setPositionMode('one_way')
  } catch (err) {
    log?.('account-setup: setPositionMode failed — no symbol tradable', { err })
    return { isReady: () => false }
  }

  for (const symbol of symbols) {
    try {
      await exchange.setMarginMode(symbol, 'isolated')
      await exchange.setLeverage(symbol, leverageFor(symbol))
      ready.add(symbol)
    } catch (err) {
      // Hard reject (`00_globals` §4): this symbol does not trade this session.
      log?.('account-setup: symbol untradable', { symbol, err })
    }
  }

  return { isReady: (symbol) => ready.has(symbol) }
}
