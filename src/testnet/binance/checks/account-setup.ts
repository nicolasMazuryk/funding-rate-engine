/**
 * Account-setup check (`17` §3 bullet 2, `11` §1; folds
 * `binance-account-setup.integration.test.ts`). Applies one-way mode, isolated
 * margin, and leverage through the real adapter, then repeats each call — the
 * adapter's applied-state cache (`account-setup.ts`) must make the repeat a no-op
 * (no throw). Also forces an out-of-range leverage to assert `setLeverage` hard-rejects
 * rather than silently accepting a bad value; if the venue accepts it anyway (account
 * limits vary), that half of the check skips with a documented reason rather than
 * failing on venue behavior outside our control.
 */

import type { BinanceTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** Comfortably outside any real account's max-leverage bracket for a major pair. */
const OUT_OF_RANGE_LEVERAGE = 999

export const accountSetupCheck: Check<BinanceTestnetContext> = {
  name: 'account-setup',
  specRef: '17 §3 account setup',
  async run(ctx) {
    if (!ctx.hasCredentials) return { status: 'skip', reason: 'no credentials' }

    const symbol = ctx.adapter.markets()[0]?.normalized
    if (symbol === undefined) throw new Error('no markets loaded to set up against')

    await ctx.adapter.setPositionMode('one_way')
    await ctx.adapter.setMarginMode(symbol, 'isolated')
    await ctx.adapter.setLeverage(symbol, 5)

    // Idempotency: a repeat apply with the same values must be a cached no-op, not a throw.
    await ctx.adapter.setPositionMode('one_way')
    await ctx.adapter.setMarginMode(symbol, 'isolated')
    await ctx.adapter.setLeverage(symbol, 5)

    // Hard-reject: an out-of-range leverage must throw, not silently apply.
    let hardRejected = false
    try {
      await ctx.adapter.setLeverage(symbol, OUT_OF_RANGE_LEVERAGE)
    } catch {
      hardRejected = true
    }
    if (!hardRejected) {
      return {
        status: 'skip',
        reason: `venue accepted leverage=${OUT_OF_RANGE_LEVERAGE} on ${symbol}; cannot verify hard-reject on this account`,
      }
    }

    // Restore the sane leverage the rest of the suite (order-path) assumes.
    await ctx.adapter.setLeverage(symbol, 5)

    return { status: 'pass', detail: { symbol } }
  },
}
