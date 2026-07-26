/**
 * Error-taxonomy check (`17` §3 bullet 5, `10` §5) — KuCoin codes, not Binance/Bybit/OKX/Bitget
 * ones. Two parts, plus two documented gaps:
 *
 *  1. **One table, three arrival shapes** (credential-free). KuCoin reuses one code space across
 *     REST and the WS trade API — the success envelope is `"200000"` on both — so `error-map.ts`
 *     classifies both from one table. Asserted by feeding each code through every shape it
 *     actually arrives in: the native lib's thrown object (top-level `code` is the **HTTP
 *     status**, the venue code nested at `body.code` — Bitget's trap, confirmed live here by a
 *     `403` + `body.code: '400006'` IP-allowlist rejection), the flat WS-API reject frame, and a
 *     ccxt error with the body embedded in its message. A mapper reading the top-level `code`
 *     would classify every REST rejection as its HTTP status.
 *
 *  2. **The live venue agrees with the table** (credentialed) — and here it is a **read**, not a
 *     write. The sibling registries cancel an order that was never placed; `cancelOrder` is a
 *     *write* against what on KuCoin is a live account, so this uses `getOrder` on a
 *     never-submitted `clientOid` instead. KuCoin is the one venue where that reaches the venue
 *     at all: ccxt maps `{ clientOid }` to `GET /api/v1/orders/byClientOid`, keyed by the client
 *     id alone (OKX and Bitget both demand the instrument, so their equivalent short-circuits
 *     locally). So the assertion is end-to-end: the venue's own not-found code must arrive
 *     **tabled** and surface through the adapter as the shared typed `NotFoundError` the order
 *     manager depends on (`11` §6). An untabled code would fall through to `NetworkError`
 *     (retryable) — exactly the silent mis-classification this check exists to catch, so it
 *     fails loud and names the code to add.
 *
 * The two gaps, deliberate and reported as `skip` reasons rather than quietly dropped:
 *
 *  - **`429000` / rate-limited.** Inducing a real 429 means deliberately exhausting a live
 *    account's shared 30 s resource pool, which would also throttle anything else that account
 *    is doing. Table-asserted only.
 *  - **`OrderRejected`.** Every path to it is a submit. The siblings get it free from
 *    `order-path`; this tier has no order path (see `../registry.ts`), so it is table-asserted
 *    only too.
 */

import { mapKucoinError } from '../../../adapters/exchanges/kucoin/error-map.js'
import { AdapterError } from '../../../adapters/shared/errors.js'
import { makeClientOrderId } from '../../../core/order-id/client-order-id.js'
import type { VenueErrorKind } from '../../../core/ports/exchange-adapter.js'
import type { KucoinLiveContext } from '../../context.js'
import type { Check } from '../../types.js'

/** Representative tabled codes and the kind `error-map.ts` must give them (`10` §5). */
const TABLED: readonly { readonly code: string; readonly kind: VenueErrorKind }[] = [
  { code: '100004', kind: 'NotFound' }, // order does not exist / non-cancelable — the live probe below
  { code: '300003', kind: 'InsufficientBalance' }, // balance not enough to place the order
  { code: '300000', kind: 'OrderRejected' }, // request parameter illegal (no live probe — see header)
  { code: '429000', kind: 'RateLimited' }, // resource-pool quota exhausted (no live probe — see header)
  { code: '400004', kind: 'AuthError' }, // KC-API-PASSPHRASE error — the third credential
  { code: '400006', kind: 'AuthError' }, // requesting IP not allowlisted — the one code seen live
]

/** The native REST throw: HTTP status at the top, the venue envelope nested under `body`. */
function asNativeRestBody(code: string): unknown {
  return { code: 400, message: 'Bad Request', body: { code, msg: 'probe', data: null } }
}

/** A WS-API reject frame as `ws-orders.ts` sees it: flat, carrying the venue `code`/`msg`. */
function asWsApiError(code: string): Error {
  const err = new Error('kucoin ws-api error')
  Object.assign(err, { code, msg: 'probe' })
  return err
}

/** Assert one code classifies identically in all three shapes it can reach the mapper in. */
function assertShapesAgree(code: string, kind: VenueErrorKind): void {
  const shapes: readonly { readonly label: string; readonly err: unknown }[] = [
    { label: 'native rest body', err: asNativeRestBody(code) },
    { label: 'ws-api frame', err: asWsApiError(code) },
    { label: 'ccxt message', err: new Error(`kucoinfutures {"code":"${code}","msg":"probe"}`) },
  ]
  for (const shape of shapes) {
    const mapped = mapKucoinError(shape.err)
    if (mapped.kind !== kind) {
      throw new Error(`code ${code} (${shape.label}) mapped to '${mapped.kind}', expected '${kind}'`)
    }
  }
}

/** The two halves this tier cannot probe live, recorded in the summary rather than omitted. */
const UNPROBED = {
  rateLimited: 'skipped (429000 would mean exhausting a LIVE account’s shared 30s resource pool)',
  orderRejected: 'skipped (every path to OrderRejected is a submit; this tier is read-only)',
} as const

export const errorTaxonomyCheck: Check<KucoinLiveContext> = {
  name: 'error-taxonomy',
  specRef: '17 §3 error taxonomy',
  async run(ctx) {
    for (const { code, kind } of TABLED) assertShapesAgree(code, kind)

    if (!ctx.hasCredentials) {
      return { status: 'skip', reason: 'no credentials (mapping table asserted, live venue probe needs keys)' }
    }

    // Live probe, and it is a **read**: look up an order that was never submitted. KuCoin reads
    // by client id alone, so this really does reach the venue and come back as its own code.
    const unknownId = makeClientOrderId({ intentId: `tn-unk-${ctx.clock.now()}`, leg: 'entry', attempt: 1 })
    let liveErr: unknown
    try {
      await ctx.adapter.getOrder(unknownId)
    } catch (err) {
      liveErr = err
    }
    if (liveErr === undefined) {
      throw new Error(`getOrder of a never-submitted clientOid '${unknownId}' did not error (the venue found it)`)
    }
    if (!(liveErr instanceof AdapterError)) {
      throw new Error(
        `getOrder of an unknown clientOid threw a raw error, not a typed AdapterError: ${String(liveErr)}`,
      )
    }
    if (liveErr.kind !== 'NotFound') {
      throw new Error(
        `live getOrder-unknown returned code ${String(liveErr.rawCode)} → '${liveErr.kind}', expected 'NotFound'; add the code to kucoin/error-map.ts`,
      )
    }

    return {
      status: 'pass',
      detail: { tabledCodes: TABLED.map((t) => t.code), liveNotFoundCode: liveErr.rawCode, ...UNPROBED },
    }
  },
}
