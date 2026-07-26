/**
 * Flatness **assertion** (`17` §3 cleanup). Runs last in the registry, as on the four sibling
 * venues — but this one is the name taken literally: it *asserts* flat, and never makes flat.
 *
 * On a sandbox venue this check cancels leftover orders and sends a `reduceOnly` market order to
 * close any leftover position. On KuCoin there is no sandbox: the account is **live, with real
 * money**. A `reduceOnly` market order there is a real market order — real fills, real fees,
 * real slippage, possibly against a position a human opened deliberately and that this suite
 * knows nothing about. Auto-flattening is the one action whose blast radius is unbounded, so it
 * is not merely gated here, it is absent: this check performs **two reads** and, on anything
 * non-flat, `throw`s naming exactly what it found and telling the operator to flatten manually.
 *
 * Failing the run is the correct outcome: a non-flat live account means the tier's assumptions
 * do not hold, and the operator — not the harness — decides what to do about a live position.
 * (The live tier's genuine auto-flatten, 0470, is a different thing with a different mandate.)
 */

import type { KucoinLiveContext } from '../../context.js'
import type { Check } from '../../types.js'

/** What to tell the operator; repeated in both messages because either can be the one they see. */
const MANUAL = 'flatten it manually in the KuCoin UI — this read-only tier will never close a live position or order'

export const assertFlatCheck: Check<KucoinLiveContext> = {
  name: 'assert-flat',
  specRef: '17 §3 cleanup',
  async run(ctx) {
    if (!ctx.hasCredentials) return { status: 'skip', reason: 'no credentials' }

    // Read 1: open positions, account-wide (`GET /api/v1/positions` under the adapter).
    const positions = await ctx.adapter.getPositions()
    const open = positions.filter((p) => p.qty > 0)
    if (open.length > 0) {
      const named = open.map((p) => `${p.symbol} ${p.side} ${p.qty}`).join(', ')
      throw new Error(`LIVE account is not flat: ${named}. ${MANUAL}`)
    }

    // Read 2: resting orders, account-wide. Straight off the ccxt client — the `ExchangeAdapter`
    // port exposes no open-order read, and the native cancel surface is deliberately not touched.
    const openOrders = await ctx.clients.ccxt.fetchOpenOrders()
    if (openOrders.length > 0) {
      const named = openOrders.map((o) => `${o.symbol ?? '?'} ${o.side ?? '?'} ${o.amount ?? '?'} (${o.id})`).join(', ')
      throw new Error(`LIVE account has resting orders: ${named}. ${MANUAL}`)
    }

    return { status: 'pass', detail: { flat: true, orderless: true, mode: 'assert-only (live account)' } }
  },
}
