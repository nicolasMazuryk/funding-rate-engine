/**
 * Order-path check (`17` §3 bullet 3, `11` §5–§6). WS-first place → `getOrder` OPEN →
 * cancel → CANCELLED; a resubmit with the same `clientOrderId` must not blow up the harness
 * (either the venue no-ops it or it maps to a typed `AdapterError` — never a raw throw). A
 * deliberately malformed (sub-minimum) order must surface as a typed `OrderRejected`.
 * Self-checks balance first — skips with reason on an unfunded demo account.
 *
 * OKX specifics:
 *  - **the size on the wire is a contract count.** `minQty` (`minSz`) and the `sz` the
 *    transport sends are both in contracts, and one BTC contract is `ctVal` = 0.01 BTC, so
 *    the notional this check risks is `qty × contractSize × price` — the first venue where
 *    those are not the same number (DoD 1, live);
 *  - **the client id is re-spelled.** `clOrdId` is alphanumeric-only and 32 chars, so the
 *    engine's `tn-…-entry-1` goes through `client-order-id.ts` on the way out and back on the
 *    `orders` channel. Nothing here needs to know that — which is the point: the harness uses
 *    the engine's own id end to end;
 *  - **the resting price is anchored to the live last price**, as on Bybit: OKX enforces a
 *    price-limit band around the mark (`51006`), so a hard-coded far-from-market price would
 *    be rejected as out of range. A few percent below last is inside any band yet never fills
 *    within the check's lifetime.
 *
 * Registers a cleanup that cancels the resting order on any mid-check throw, so a failure
 * here can't leak an open order.
 */

import { AdapterError } from '../../../adapters/shared/errors.js'
import { makeClientOrderId } from '../../../core/order-id/client-order-id.js'
import type { Instrument } from '../../../core/ports/exchange-adapter.js'
import { minFeasibleQty } from '../../../core/sizing/sizing.js'
import type { OkxTestnetContext } from '../../context.js'
import { retry } from '../../runner.js'
import type { Check } from '../../types.js'

/** The only symbol this suite trades; ccxt's unified name for the price anchor read. */
const SYMBOL = 'BTC'
const CCXT_SYMBOL = 'BTC/USDT:USDT'

/** Resting buy limit at 97 % of last: inside OKX's price-limit band, never fills in-check. */
const PRICE_FACTOR = 0.97
const MIN_FREE_USDT = 10

/** The one OKX account level that accepts an isolated-margin swap order (`account-setup.ts`). */
const REQUIRED_ACCOUNT_LEVEL = '2'

/** Notional actually risked by a contract-denominated order (`10` §4 denomination boundary). */
function notionalOf(qty: number, inst: Instrument, price: number): number {
  return qty * inst.contractSize * price
}

export const orderPathCheck: Check<OkxTestnetContext> = {
  name: 'order-path',
  specRef: '17 §3 order path',
  async run(ctx) {
    if (!ctx.hasCredentials) return { status: 'skip', reason: 'no credentials' }

    const free = await ctx.getBalanceFree()
    if (free < MIN_FREE_USDT) return { status: 'skip', reason: `unfunded demo account (free=${free} USDT)` }

    // Account-mode gate: on any level but `2` the venue refuses the order itself (`51010` on
    // level 1 — spot mode, no derivatives; `tdMode: 'isolated'` unavailable on 3/4), and the
    // switch is privileged (`51070`, UI-only). That is a property of the account, so it skips
    // with the level named rather than failing on something this code cannot fix.
    const acctLv = (await ctx.clients.native.getAccountConfiguration())[0]?.acctLv
    if (acctLv !== REQUIRED_ACCOUNT_LEVEL) {
      return {
        status: 'skip',
        reason: `account level is '${String(acctLv)}', isolated swap orders need '${REQUIRED_ACCOUNT_LEVEL}' (spot-and-futures) — upgrade the account mode in the OKX UI`,
      }
    }

    const inst = ctx.adapter.normalize(SYMBOL)
    const ticker = await ctx.clients.ccxt.fetchTicker(CCXT_SYMBOL)
    const last = ticker.last
    if (last === undefined || !Number.isFinite(last) || last <= 0) {
      throw new Error(`no usable last price for ${CCXT_SYMBOL}: ${String(last)}`)
    }
    const price = last * PRICE_FACTOR // the order manager tick-rounds it (`11` §3)
    // Smallest order the venue accepts: OKX publishes no per-instrument min notional, so this
    // resolves to the lot minimum in contracts.
    const qty = minFeasibleQty(price, inst)

    const clientOrderId = makeClientOrderId({ intentId: `tn-${ctx.clock.now()}`, leg: 'entry', attempt: 1 })
    let resting = true
    ctx.onCleanup(async () => {
      if (resting) {
        try {
          await ctx.adapter.cancelOrder(clientOrderId)
        } catch {
          // Best-effort: if it never rested, or is already gone, there's nothing to cancel.
        }
      }
    })

    const placed = await ctx.adapter.placeOrder({
      symbol: SYMBOL,
      side: 'long',
      type: 'limit',
      qty,
      price,
      clientOrderId,
    })
    if (!placed.accepted) throw new Error('order was not accepted')

    // Known-slow venue op: a `getOrder` read immediately after submit can briefly lag, so
    // retry a few times before treating it as a failure.
    await retry(async () => {
      const o = await ctx.adapter.getOrder(clientOrderId)
      if (o.status !== 'OPEN') throw new Error(`expected OPEN after submit, got ${o.status}`)
    }, 3)

    // clientOrderId idempotency: a resubmit must not throw an unmapped/raw error — either the
    // venue treats it as a no-op (accepted) or it maps to a typed AdapterError (OKX answers a
    // duplicate `clOrdId` with `51000`-class parameter error; even an untabled code lands as a
    // typed `NetworkError` rather than a raw throw).
    try {
      await ctx.adapter.placeOrder({ symbol: SYMBOL, side: 'long', type: 'limit', qty, price, clientOrderId })
    } catch (err) {
      if (!(err instanceof AdapterError)) throw new Error(`resubmit threw an unmapped error: ${String(err)}`)
    }

    await ctx.adapter.cancelOrder(clientOrderId)
    resting = false
    // Same known-slow-read lag as the post-submit check above.
    await retry(async () => {
      const cancelled = await ctx.adapter.getOrder(clientOrderId)
      if (cancelled.status !== 'CANCELLED') throw new Error(`expected CANCELLED after cancel, got ${cancelled.status}`)
    }, 3)

    // Malformed (sub-minimum) order must surface as a typed OrderRejected, not accept or throw
    // raw — the order manager rejects pre-submit (`11` §3) and publishes the verdict on the bus
    // rather than throwing, so assert against the published event.
    const badClientOrderId = makeClientOrderId({ intentId: `tn-bad-${ctx.clock.now()}`, leg: 'entry', attempt: 1 })
    const badAck = await ctx.adapter.placeOrder({
      symbol: SYMBOL,
      side: 'long',
      type: 'limit',
      qty: inst.minQty / 10,
      price: 1,
      clientOrderId: badClientOrderId,
    })
    if (badAck.accepted) throw new Error('malformed (sub-minimum) order was accepted, expected a reject')
    const rejectedEvent = ctx.events.find(
      (e) => e.type === 'OrderUpdate' && e.clientOrderId === badClientOrderId && e.status === 'REJECTED',
    )
    if (
      rejectedEvent === undefined ||
      rejectedEvent.type !== 'OrderUpdate' ||
      rejectedEvent.errorKind !== 'OrderRejected'
    ) {
      throw new Error('malformed (sub-minimum) order did not surface as typed OrderRejected')
    }

    return {
      status: 'pass',
      detail: { qty, price, contractSize: inst.contractSize, notionalUsd: notionalOf(qty, inst, price) },
    }
  },
}
