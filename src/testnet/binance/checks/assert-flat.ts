/**
 * Assert-flat check (`17` §3 cleanup; task 0260 implementation note). Runs **last** in
 * the registry: cancels any open orders and flattens any open position left over from
 * an earlier check's failure, then asserts the account is flat and orderless at exit.
 * Previews the live tier's auto-flatten (0470) — this is the one check every other
 * venue's testnet tier must also end on.
 */

import { makeClientOrderId } from '../../../core/order-id/client-order-id.js'
import type { BinanceTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** This suite only ever trades BTC — ccxt's unified symbol for `fetchOpenOrders`. */
const BTC_CCXT_SYMBOL = 'BTC/USDT:USDT'

export const assertFlatCheck: Check<BinanceTestnetContext> = {
  name: 'assert-flat',
  specRef: '17 §3 cleanup',
  async run(ctx) {
    if (!ctx.hasCredentials) return { status: 'skip', reason: 'no credentials' }

    // Cancel any resting order left over from an earlier check's failure. Goes through
    // the raw ccxt client (not the adapter port) since `fetchOpenOrders` is account-wide
    // and the port only exposes single-order `getOrder`. Scoped to BTC (the only symbol
    // this suite trades) — an unscoped account-wide fetch carries a steep ccxt rate-limit
    // penalty (documented warning) this harness doesn't need to pay.
    const openOrders = await ctx.clients.ccxt.fetchOpenOrders(BTC_CCXT_SYMBOL)
    for (const o of openOrders) {
      const info = o.info as { symbol?: string } | undefined
      const rawSymbol = info?.symbol
      if (rawSymbol === undefined || o.clientOrderId === undefined) continue
      await ctx.clients.wsApiPrivate.cancelFuturesOrder('usdm', {
        symbol: rawSymbol,
        origClientOrderId: o.clientOrderId,
        timestamp: ctx.clock.now(),
      })
    }

    const positions = await ctx.adapter.getPositions()
    for (const p of positions) {
      if (p.qty > 0) {
        await ctx.adapter.placeOrder({
          symbol: p.symbol,
          side: p.side === 'long' ? 'short' : 'long',
          type: 'market',
          qty: p.qty,
          reduceOnly: true,
          clientOrderId: makeClientOrderId({ intentId: `tn-flat-${ctx.clock.now()}`, leg: 'exit', attempt: 1 }),
        })
      }
    }

    const stillOpen = await ctx.adapter.getPositions()
    if (stillOpen.some((p) => p.qty > 0)) {
      throw new Error(`account not flat at suite end: ${JSON.stringify(stillOpen)}`)
    }
    const stillResting = await ctx.clients.ccxt.fetchOpenOrders(BTC_CCXT_SYMBOL)
    if (stillResting.length > 0) {
      throw new Error(`account not orderless at suite end: ${JSON.stringify(stillResting)}`)
    }

    return { status: 'pass', detail: { flat: true, orderless: true } }
  },
}
