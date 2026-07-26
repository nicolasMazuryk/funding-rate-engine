/**
 * Error-taxonomy check (`17` §3 bullet 5, `10` §5) — Bitget v3/UTA codes, not Binance, Bybit or
 * OKX ones. Three parts, in increasing cost:
 *
 *  1. **One table, three arrival shapes** (credential-free). Bitget reuses one code space
 *     across REST and the WS trade API, so `error-map.ts` classifies both from one table.
 *     Asserted by feeding one code through every shape it actually arrives in — the native
 *     lib's thrown object (a **fourth** reject shape across the four venues: the top-level
 *     `code` is the *HTTP status* and the venue code is nested at `body.code`), the WS-API
 *     reply lifted onto an `Error` carrying `code`/`msg`, and a ccxt error with the body
 *     embedded in its message — and requiring the same kind from each. The nested-envelope
 *     trap is the point: a mapper that read the top-level `code` would see `400` for every
 *     rejection and classify them all as one retryable unknown.
 *  2. **The live venue agrees with the table** (credentialed). Cancelling an order that was
 *     never placed is the one safe way to make the real venue emit a real error: it must come
 *     back as a *tabled* code mapping to `NotFound`. An untabled code would fall through to
 *     `NetworkError` (retryable) — exactly the silent mis-classification this check exists to
 *     catch, so it fails loud and names the code to add.
 *  3. **The adapter surfaces the typed error** (credentialed): `getOrder` on a never-placed
 *     `clientOrderId` must throw the shared typed `NotFoundError`. As on OKX this resolves
 *     *locally*: the venue's order read demands the symbol, which only a submit (or an `order`
 *     frame) can supply, so an id the adapter has never seen cannot be queried at all. That the
 *     miss is still a typed `NotFoundError` rather than a raw throw is what the order manager
 *     depends on (`11` §6).
 *
 * `cancelOrder` through the *adapter* is deliberately not used for (3): the order manager
 * swallows a `NotFound` cancel as "already gone" per `11` §6, so it never throws.
 * Malformed-order → `OrderRejected` is exercised by `order-path` (one order lifecycle, not
 * duplicated here). Inducing a real 429 is unsafe against a shared venue (demo trading rides
 * the production rate limiter), so that half is a documented skip.
 */

import { mapBitgetError } from '../../../adapters/exchanges/bitget/error-map.js'
import { AdapterError } from '../../../adapters/shared/errors.js'
import { makeClientOrderId } from '../../../core/order-id/client-order-id.js'
import type { VenueErrorKind } from '../../../core/ports/exchange-adapter.js'
import type { BitgetTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** Representative tabled codes and the kind `error-map.ts` must give them (`10` §5). */
const TABLED: readonly { readonly code: string; readonly kind: VenueErrorKind }[] = [
  { code: '25204', kind: 'NotFound' }, // order does not exist — the live probe below
  { code: '25202', kind: 'InsufficientBalance' }, // insufficient balance
  { code: '25212', kind: 'OrderRejected' }, // duplicate clientOid
  { code: '25004', kind: 'RateLimited' }, // operation too frequent
  { code: '40012', kind: 'AuthError' }, // apikey or passphrase incorrect — the third credential
]

/** The native REST throw: HTTP status at the top, the venue envelope nested under `body`. */
function asNativeRestBody(code: string): unknown {
  return { code: 400, message: 'Bad Request', body: { code, msg: 'probe', data: null } }
}

/** A WS-API reply as `ws-orders.ts` hands it on: an `Error` carrying the venue `code`/`msg`. */
function asWsApiError(code: string): Error {
  const err = new Error('bitget ws-api error')
  Object.assign(err, { code, msg: 'probe' })
  return err
}

/** Assert one code classifies identically in all three shapes it can reach the mapper in. */
function assertShapesAgree(code: string, kind: VenueErrorKind): void {
  const shapes: readonly { readonly label: string; readonly err: unknown }[] = [
    { label: 'native rest body', err: asNativeRestBody(code) },
    { label: 'ws-api lifted', err: asWsApiError(code) },
    { label: 'ccxt message', err: new Error(`bitget {"code":"${code}","msg":"probe"}`) },
  ]
  for (const shape of shapes) {
    const mapped = mapBitgetError(shape.err)
    if (mapped.kind !== kind) {
      throw new Error(`code ${code} (${shape.label}) mapped to '${mapped.kind}', expected '${kind}'`)
    }
  }
}

export const errorTaxonomyCheck: Check<BitgetTestnetContext> = {
  name: 'error-taxonomy',
  specRef: '17 §3 error taxonomy',
  async run(ctx) {
    for (const { code, kind } of TABLED) assertShapesAgree(code, kind)

    if (!ctx.hasCredentials) {
      return { status: 'skip', reason: 'no credentials (mapping table asserted, live venue probe needs keys)' }
    }

    // Live probe: cancel an order that never existed. Safe (it cancels nothing) and the only
    // reliable way to get the real venue to emit a real code.
    const unknownId = makeClientOrderId({ intentId: `tn-unk-${ctx.clock.now()}`, leg: 'entry', attempt: 1 })
    let liveMapped: AdapterError | undefined
    try {
      await ctx.clients.native.cancelOrder({ category: 'USDT-FUTURES', clientOid: 'tn-never-placed-1' })
    } catch (err) {
      liveMapped = mapBitgetError(err)
    }
    if (liveMapped === undefined) {
      throw new Error('cancel of a never-placed clientOid did not error (the venue accepted it)')
    }
    if (liveMapped.kind !== 'NotFound') {
      throw new Error(
        `live cancel-unknown returned code ${String(liveMapped.rawCode)} → '${liveMapped.kind}', expected 'NotFound'; add the code to bitget/error-map.ts`,
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
