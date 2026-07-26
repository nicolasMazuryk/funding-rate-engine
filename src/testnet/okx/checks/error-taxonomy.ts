/**
 * Error-taxonomy check (`17` §3 bullet 5, `10` §5) — OKX v5 codes, not Binance or Bybit ones.
 * Three parts, in increasing cost:
 *
 *  1. **One table, three arrival shapes** (credential-free). OKX reuses one code space across
 *     REST and the WS trade API, so `error-map.ts` classifies both from one table. Asserted by
 *     feeding one code through every shape it actually arrives in — the native lib's thrown
 *     body (a `code: '1'` envelope with the real reason at `data[0].sCode`, the **third**
 *     reject shape across the three venues), the WS-API reply lifted onto an `Error` carrying
 *     `code`/`data` (`ws-orders.ts`), and a ccxt error with the body embedded in its message —
 *     and requiring the same kind from each. The envelope trap is the point: `code: '1'` is
 *     *not* an error code, and a mapper that read it would classify every rejection the same.
 *  2. **The live venue agrees with the table** (credentialed). Cancelling an order that was
 *     never placed is the one safe way to make the real venue emit a real error: it must come
 *     back as a *tabled* code mapping to `NotFound`. An untabled code would fall through to
 *     `NetworkError` (retryable) — exactly the silent mis-classification this check exists to
 *     catch, so it fails loud and names the code to add.
 *  3. **The adapter surfaces the typed error** (credentialed): `getOrder` on a never-placed
 *     `clientOrderId` must throw the shared typed `NotFoundError`. On OKX this one resolves
 *     *locally*: the venue's order read requires an `instId`, which only a submit (or an
 *     `orders` frame) can supply, so an id the adapter has never seen cannot be queried at
 *     all. That the miss is still a typed `NotFoundError` rather than a raw throw is what the
 *     order manager depends on (`11` §6).
 *
 * `cancelOrder` through the *adapter* is deliberately not used for (3): the order manager
 * swallows a `NotFound` cancel as "already gone" per `11` §6, so it never throws.
 * Malformed-order → `OrderRejected` is exercised by `order-path` (one order lifecycle, not
 * duplicated here). Inducing a real 429 is unsafe against a shared venue (demo trading rides
 * the production rate limiter), so that half is a documented skip.
 */

import { mapOkxError } from '../../../adapters/exchanges/okx/error-map.js'
import { AdapterError } from '../../../adapters/shared/errors.js'
import { makeClientOrderId } from '../../../core/order-id/client-order-id.js'
import type { VenueErrorKind } from '../../../core/ports/exchange-adapter.js'
import type { OkxTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** The only symbol this suite trades — the cancel probe needs an `instId` OKX accepts. */
const SYMBOL = 'BTC'

/** Representative tabled codes and the kind `error-map.ts` must give them (`10` §5). */
const TABLED: readonly { readonly code: number; readonly kind: VenueErrorKind }[] = [
  { code: 51400, kind: 'NotFound' }, // cancellation failed — order does not exist
  { code: 51008, kind: 'InsufficientBalance' }, // insufficient account balance
  { code: 50011, kind: 'RateLimited' }, // rate limit reached
  { code: 50105, kind: 'AuthError' }, // invalid OK-ACCESS-PASSPHRASE — the OKX-only credential
]

/** The native REST throw: the whole `{code:'1', data:[{sCode}]}` envelope, reason nested. */
function asNativeRestBody(code: number): unknown {
  return { code: '1', msg: '', data: [{ sCode: String(code), sMsg: 'probe' }] }
}

/** A WS-API reply as `ws-orders.ts#liftWsApiError` hands it on: an `Error` carrying `code`/`data`. */
function asWsApiError(code: number): Error {
  const err = new Error('okx ws-api error')
  Object.assign(err, { code: '1', data: [{ sCode: String(code), sMsg: 'probe' }] })
  return err
}

/** Assert one code classifies identically in all three shapes it can reach the mapper in. */
function assertShapesAgree(code: number, kind: VenueErrorKind): void {
  const shapes: readonly { readonly label: string; readonly err: unknown }[] = [
    { label: 'native rest body', err: asNativeRestBody(code) },
    { label: 'ws-api lifted', err: asWsApiError(code) },
    { label: 'ccxt message', err: new Error(`okx {"code":"${code}","msg":"probe"}`) },
  ]
  for (const shape of shapes) {
    const mapped = mapOkxError(shape.err)
    if (mapped.kind !== kind) {
      throw new Error(`code ${code} (${shape.label}) mapped to '${mapped.kind}', expected '${kind}'`)
    }
  }
}

export const errorTaxonomyCheck: Check<OkxTestnetContext> = {
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
      await ctx.clients.native.cancelOrder({ instId: venueSymbol, clOrdId: 'tnunknown0000' })
    } catch (err) {
      liveMapped = mapOkxError(err)
    }
    if (liveMapped === undefined) {
      throw new Error(`cancel of a never-placed clOrdId did not error (venue accepted it on '${venueSymbol}')`)
    }
    if (liveMapped.kind !== 'NotFound') {
      throw new Error(
        `live cancel-unknown returned code ${String(liveMapped.rawCode)} → '${liveMapped.kind}', expected 'NotFound'; add the code to okx/error-map.ts`,
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
        rateLimited: 'skipped (unsafe to induce a real 429 — demo trading shares the production limiter)',
      },
    }
  },
}
