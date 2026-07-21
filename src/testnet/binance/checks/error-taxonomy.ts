/**
 * Error-taxonomy check (`17` §3 bullet 5, `10` §5). `getOrder` on a never-placed
 * `clientOrderId` must surface the shared typed `NotFoundError`, not a raw throw
 * (`cancelOrder` is the wrong call to test this — the order manager deliberately
 * swallows a `NotFound` cancel as "already gone, resolve to truth" per `11` §6, so it
 * never throws). Malformed-order → `OrderRejected` is exercised by `order-path` (one
 * order lifecycle, not duplicated here). Inducing a real 429 is unsafe against a
 * shared testnet (could rate-limit other suites/CI runs concurrently), so that half is
 * a documented skip.
 */

import { AdapterError } from '../../../adapters/shared/errors.js'
import { makeClientOrderId } from '../../../core/order-id/client-order-id.js'
import type { BinanceTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

export const errorTaxonomyCheck: Check<BinanceTestnetContext> = {
  name: 'error-taxonomy',
  specRef: '17 §3 error taxonomy',
  async run(ctx) {
    if (!ctx.hasCredentials) return { status: 'skip', reason: 'no credentials' }

    // Binance caps `newClientOrderId` at 36 chars — keep the prefix short so the epoch
    // millis suffix always fits (`makeClientOrderId` fails loud on an over-long id).
    const unknownId = makeClientOrderId({ intentId: `tn-unk-${ctx.clock.now()}`, leg: 'entry', attempt: 1 })
    let notFoundTyped = false
    try {
      await ctx.adapter.getOrder(unknownId)
    } catch (err) {
      notFoundTyped = err instanceof AdapterError && err.kind === 'NotFound'
    }
    if (!notFoundTyped) {
      throw new Error('getOrder of an unknown clientOrderId did not surface as typed NotFoundError')
    }

    return {
      status: 'pass',
      detail: { notFound: true, rateLimited: 'skipped (unsafe to induce a real 429 on shared testnet)' },
    }
  },
}
