/**
 * Error-taxonomy check (`17` §3 bullet 5, `10` §5) — Bybit `retCode`s, not Binance codes.
 * Three parts, in increasing cost:
 *
 *  1. **One table, both transports** (credential-free). Bybit reuses the same code space for
 *     REST and the WS trade API, so `error-map.ts` classifies both from one table. Asserted by
 *     feeding one code through all three shapes it actually arrives in — the native lib's raw
 *     body (`{retCode}`), the WS-API reply lifted onto `Error.code` (`ws-orders.ts`), and a
 *     ccxt `ExchangeError` with the body embedded in its message — and requiring the same kind.
 *  2. **The live venue agrees with the table** (credentialed). Cancelling an order that was
 *     never placed is the one safe way to make the real venue emit a real error: it must come
 *     back as a *tabled* code mapping to `NotFound`. An untabled code would fall through to
 *     `NetworkError` (retryable) — exactly the silent mis-classification this check exists to
 *     catch, so it fails loud and names the code to add.
 *  3. **The adapter surfaces the typed error** (credentialed): `getOrder` on a never-placed
 *     `clientOrderId` must throw the shared typed `NotFoundError`, not a raw throw.
 *
 * `cancelOrder` through the *adapter* is deliberately not used for (3): the order manager
 * swallows a `NotFound` cancel as "already gone" per `11` §6, so it never throws.
 * Malformed-order → `OrderRejected` is exercised by `order-path` (one order lifecycle, not
 * duplicated here). Inducing a real 429 is unsafe against a shared testnet (it would
 * rate-limit concurrent suites/CI runs), so that half is a documented skip.
 */

import { mapBybitError } from '../../../adapters/exchanges/bybit/error-map.js'
import { AdapterError } from '../../../adapters/shared/errors.js'
import { makeClientOrderId } from '../../../core/order-id/client-order-id.js'
import type { VenueErrorKind } from '../../../core/ports/exchange-adapter.js'
import type { BybitTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** The only symbol this suite trades — the cancel probe needs a symbol Bybit accepts. */
const SYMBOL = 'BTC'

/** Representative tabled codes and the kind `error-map.ts` must give them (`10` §5). */
const TABLED: readonly { readonly code: number; readonly kind: VenueErrorKind }[] = [
  { code: 110001, kind: 'NotFound' }, // order does not exist
  { code: 110007, kind: 'InsufficientBalance' }, // insufficient available balance
  { code: 10006, kind: 'RateLimited' }, // too many visits (UID rate limit)
  { code: 10003, kind: 'AuthError' }, // invalid API key
]

/** A WS-API reply as `ws-orders.ts` hands it on: a real `Error` carrying `retCode` on `.code`. */
function asWsApiError(code: number): Error {
  const err = new Error('bybit ws-api error')
  ;(err as { code?: unknown }).code = code
  return err
}

/** Assert one code classifies identically in all three shapes it can reach the mapper in. */
function assertShapesAgree(code: number, kind: VenueErrorKind): void {
  const shapes: readonly { readonly label: string; readonly err: unknown }[] = [
    { label: 'native rest body', err: { retCode: code, retMsg: 'probe' } },
    { label: 'ws-api lifted', err: asWsApiError(code) },
    { label: 'ccxt message', err: new Error(`bybit {"retCode":${code},"retMsg":"probe"}`) },
  ]
  for (const shape of shapes) {
    const mapped = mapBybitError(shape.err)
    if (mapped.kind !== kind) {
      throw new Error(`retCode ${code} (${shape.label}) mapped to '${mapped.kind}', expected '${kind}'`)
    }
  }
}

export const errorTaxonomyCheck: Check<BybitTestnetContext> = {
  name: 'error-taxonomy',
  specRef: '17 §3 error taxonomy',
  async run(ctx) {
    for (const { code, kind } of TABLED) assertShapesAgree(code, kind)

    if (!ctx.hasCredentials) {
      return { status: 'skip', reason: 'no credentials (mapping table asserted, live venue probe needs keys)' }
    }

    // Live probe: cancel an order that never existed. Safe (it cancels nothing) and the only
    // reliable way to get the real venue to emit a real code.
    const venueSymbol = ctx.adapter.normalize(SYMBOL).venueSymbol
    const unknownId = makeClientOrderId({ intentId: `tn-unk-${ctx.clock.now()}`, leg: 'entry', attempt: 1 })
    let liveMapped: AdapterError | undefined
    try {
      await ctx.clients.native.cancelOrder({ category: 'linear', symbol: venueSymbol, orderLinkId: unknownId })
    } catch (err) {
      liveMapped = mapBybitError(err)
    }
    if (liveMapped === undefined) {
      throw new Error(`cancel of a never-placed orderLinkId did not error (venue accepted '${unknownId}')`)
    }
    if (liveMapped.kind !== 'NotFound') {
      throw new Error(
        `live cancel-unknown returned retCode ${String(liveMapped.rawCode)} → '${liveMapped.kind}', expected 'NotFound'; add the code to bybit/error-map.ts`,
      )
    }

    // The adapter's own surface: an unknown clientOrderId is a typed NotFoundError.
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
      detail: {
        tabledCodes: TABLED.map((t) => t.code),
        liveNotFoundCode: liveMapped.rawCode,
        rateLimited: 'skipped (unsafe to induce a real 429 on shared testnet)',
      },
    }
  },
}
