/**
 * KuCoin venue-error mapping (`10_exchange_adapters_and_market_data.md` §5). Turns any
 * ccxt/native throw into exactly one {@link AdapterError} — the core only ever sees one of eight
 * kinds, never a raw venue code. Mapping tables are adapter-local; the union is shared (task
 * 0200 decision 5), so this file mirrors `../bitget/error-map.ts` structurally and only the
 * table and the code extraction differ.
 *
 * Resolution order (same as the siblings):
 *  1. **Venue code wins** — read off the error object, else parsed out of the message.
 *  2. **ccxt class** — `instanceof`, most-specific subclass first (`OrderNotFound` before its
 *     `InvalidOrder` parent, else a not-found would read as a rejection).
 *  3. **Unknown → `NetworkError`** (retryable), raw code captured on the error and handed to
 *     `opts.onUnknown` so the adapter logs it. Never a raw re-throw.
 *
 * KuCoin quirks:
 *  - codes are **strings** of 4–6 digits and the success envelope is **`"200000"`**, which is
 *    not `0` — so the envelope set is a single value, and (unlike Bitget) there is no second
 *    success code for the WS surface: the WS trade API answers `200000` too;
 *  - the native SDK throws `{ code: <HTTP status>, message, body: { code: '<venue>', msg } }`,
 *    so the venue code is **nested under `body`** exactly as on Bitget — reading the top-level
 *    `code` first would classify every rejection as the HTTP status. Confirmed live against this
 *    repo's keys, and worse than on Bitget: an IP-allowlist rejection arrives as `403` +
 *    `body.code: '400006'`, but a *business* rejection arrives as HTTP **200** +
 *    `body.code: '100001'`. So the HTTP status is not even a signal of failure here — the
 *    `body.code`-first order is the only thing that classifies these correctly;
 *  - the WS-API reject frame is flat (`{ code: '429000', op, msg, … }`), and its code space
 *    **overlaps** REST's, so one table serves both.
 *
 * The table carries the codes KuCoin's own error-code references publish for the paths this
 * adapter drives. Three have been observed live from this repo (task 0460): `400006`
 * (IP not allowlisted), `100001` + `error.getOrder.orderNotExist` (the not-found case, see
 * {@link NOT_FOUND_MESSAGE}) and `100003` (a bad symbol on the venue's dry-run order endpoint).
 * The rest are documented, not measured; an unlisted code maps to a retryable `NetworkError`
 * **and is logged**, which is the honest posture rather than a guessed table.
 */

import {
  AuthenticationError,
  DDoSProtection,
  ExchangeNotAvailable,
  InsufficientFunds,
  InvalidOrder,
  OnMaintenance,
  OrderNotFound,
  PermissionDenied,
  RateLimitExceeded,
  RequestTimeout,
} from 'ccxt'
import type { VenueErrorKind } from '../../../core/ports/exchange-adapter.js'
import {
  AdapterError,
  AuthError,
  InsufficientBalanceError,
  NetworkError,
  NotFoundError,
  OrderRejectedError,
  RateLimitedError,
  VenueUnavailableError,
} from '../../shared/errors.js'

export interface MapErrorOpts {
  /** Called with the raw code + original error when nothing matched (adapter logs it). */
  onUnknown?(rawCode: string | number | undefined, err: unknown): void
}

/**
 * KuCoin error code → kind (`10` §5; KuCoin general + futures error-code references). Codes are
 * strings on the wire and stay strings here. HTTP `429` sits alongside the venue codes because
 * the edge can answer rate abuse before any venue `code` exists.
 */
const CODE_KIND = new Map<string, VenueErrorKind>([
  // ── rate limiting. `429000` is *the* KuCoin rate-limit code: the resource-pool quota is
  //    weighted per endpoint over a rolling 30 s window, and exhausting it answers HTTP 429 +
  //    `429000` on REST and the same code in a WS-API reject frame.
  ['429', 'RateLimited'], // edge rejection, no venue code
  ['429000', 'RateLimited'], // resource-pool quota exhausted (30 s window)
  ['200002', 'RateLimited'], // business-layer frequency limit, blocks 10 s
  ['1015', 'RateLimited'], // Cloudflare per-IP frequency limit, blocks 30 s
  // ── auth / permissions (the `4000xx` general space).
  ['400001', 'AuthError'], // a required KC-API-* header is missing
  ['400002', 'AuthError'], // KC-API-TIMESTAMP invalid
  ['400003', 'AuthError'], // KC-API-KEY does not exist
  ['400004', 'AuthError'], // KC-API-PASSPHRASE error — the third credential
  ['400005', 'AuthError'], // signature error
  ['400006', 'AuthError'], // requesting IP is not in the key's allowlist (seen live, task 0460)
  ['400007', 'AuthError'], // access denied
  ['411100', 'AuthError'], // user is frozen
  ['40010', 'AuthError'], // restricted country/region for order placement
  // ── venue availability.
  ['500000', 'VenueUnavailable'], // internal server error
  ['100002', 'VenueUnavailable'], // system config error
  ['300002', 'VenueUnavailable'], // order placement/cancellation suspended, retry later
  // ── balance.
  ['200005', 'InsufficientBalance'], // insufficient balance (risk-limit change)
  ['300003', 'InsufficientBalance'], // balance not enough to place the order
  // ── not found: the order is gone (or never existed). `100004` is what a cancel/read of an
  //    unknown or already-terminal futures order answers, so it is the venue's not-found for
  //    the paths this adapter drives (`11` §6 treats a cancel of a gone order as success).
  ['100004', 'NotFound'], // order is in a non-cancelable state / does not exist
  // ── order rejections (parameter + trading-rule space).
  // `100001` is the venue's *generic* "there are invalid parameters", and it is genuinely
  // reused for real parameter errors — so it stays `OrderRejected` here, and the
  // order-does-not-exist case is separated out by message instead ({@link NOT_FOUND_MESSAGE}).
  ['100001', 'OrderRejected'], // invalid parameters
  ['100003', 'OrderRejected'], // contract parameter invalid
  ['200003', 'OrderRejected'], // the symbol parameter is invalid
  ['300000', 'OrderRejected'], // request parameter illegal
  ['300001', 'OrderRejected'], // active order quantity limit exceeded
  ['300004', 'OrderRejected'], // stop order quantity limit exceeded
  ['300005', 'OrderRejected'], // exceeds the maximum risk limit
  ['400100', 'OrderRejected'], // parameter error
])

/** The one KuCoin success envelope — never an error code, on REST or on the WS trade API. */
const ENVELOPE_CODES = new Set(['200000'])

/**
 * KuCoin has **no dedicated order-not-found code**. Reading an order this account never placed
 * — by `clientOid` or by `orderId` — answers HTTP **200** with
 * `{ code: '100001', msg: 'error.getOrder.orderNotExist' }`: the generic "invalid parameters"
 * code, distinguishable only by the message. Verified live against this repo's keys (task 0460);
 * the read-only tier's `error-taxonomy` check is what caught the original mis-mapping.
 *
 * So the message is consulted **before** the code table, and only for this one unambiguous key.
 * The alternative — tabling `100001` as `NotFound` — would classify every genuine parameter
 * rejection as "order gone", and `11` §6 treats a not-found cancel as "already gone, reconcile
 * to truth", i.e. it would silently swallow real submit/cancel rejections.
 *
 * `msg` is a machine-readable key (`error.<op>.orderNotExist`), not prose, so matching it is not
 * the message-scraping anti-pattern it looks like — but it is still venue text, so a miss falls
 * through to the code table rather than to a guess.
 */
const NOT_FOUND_MESSAGE = /orderNotExist/i

/** Construct the right subclass for a kind, threading raw code + reason through. */
function make(
  kind: VenueErrorKind,
  message: string,
  rawCode?: string | number,
  reason?: string,
  cause?: unknown,
): AdapterError {
  const opts = { rawCode, reason, cause }
  switch (kind) {
    case 'RateLimited':
      return new RateLimitedError(message, opts)
    case 'OrderRejected':
      return new OrderRejectedError(message, opts)
    case 'InsufficientBalance':
      return new InsufficientBalanceError(message, opts)
    case 'AuthError':
      return new AuthError(message, opts)
    case 'NotFound':
      return new NotFoundError(message, opts)
    case 'VenueUnavailable':
      return new VenueUnavailableError(message, opts)
    default:
      // WsTimeout is never produced from a REST throw; unknown kinds fall to NetworkError.
      return new NetworkError(message, opts)
  }
}

/** The venue envelope the native SDK nests under `body` when it throws on a non-2xx response. */
function bodyOf(err: unknown): Record<string, unknown> | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const body = (err as { body?: unknown }).body
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
}

/**
 * A human message for the mapped error. The native SDK throws a **plain object**, not an
 * `Error` — `String(err)` on it is the useless `[object Object]` — so the venue's own `msg`
 * (nested under `body`, else top level) and the SDK's HTTP `message` are read first.
 */
function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (typeof err === 'object' && err !== null) {
    const venueMsg = bodyOf(err)?.msg ?? (err as { msg?: unknown }).msg
    if (typeof venueMsg === 'string' && venueMsg.length > 0) return venueMsg
    const httpMsg = (err as { message?: unknown }).message
    if (typeof httpMsg === 'string' && httpMsg.length > 0) return httpMsg
  }
  return String(err)
}

/** A KuCoin code as the wire spells it, ignoring the success envelope. */
function toCode(raw: unknown): string | undefined {
  const code = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (code.length === 0 || ENVELOPE_CODES.has(code)) return undefined
  return code
}

/**
 * Read a KuCoin code, **nested envelope first**. The native client throws
 * `{ code: 403, message: 'Forbidden', body: { code: '400006' } }` — the top-level `code` is the
 * **HTTP status**, not a venue code, so reading it first would classify every rejection as the
 * same unknown. After the body come the shapes that do put the venue code at the top level (the
 * WS trade API's reject frame, ccxt's own `code`), then whatever the ccxt message embeds
 * (`kucoinfutures {"code":"400006",…}`), then a bare 4–6-digit run as a last resort.
 */
function extractCode(err: unknown): string | undefined {
  const bodyCode = toCode(bodyOf(err)?.code)
  if (bodyCode !== undefined) return bodyCode
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = toCode((err as Record<string, unknown>).code)
    if (code !== undefined) return code
  }
  const msg = extractMessage(err)
  const inJson = msg.match(/"code"\s*:\s*"?(\d+)"?/)
  const fromJson = inJson?.[1] === undefined ? undefined : toCode(inJson[1])
  if (fromJson !== undefined) return fromJson
  // KuCoin codes are 4–6 digits; a bounded pattern avoids matching a price or a quantity that
  // happens to appear in the message text.
  const bare = msg.match(/\b\d{4,6}\b/)
  return bare ? toCode(bare[0]) : undefined
}

/** The human reason KuCoin ships beside the code (`msg` on every envelope and reject frame). */
function extractReason(err: unknown, fallback: string): string {
  if (err !== null && typeof err === 'object') {
    const raw = bodyOf(err)?.msg ?? (err as Record<string, unknown>).msg
    if (typeof raw === 'string' && raw.length > 0) return raw
  }
  return fallback
}

/** Map by ccxt class — most-specific subclass first. Returns `undefined` if unrecognised. */
function mapByClass(err: unknown): VenueErrorKind | undefined {
  if (err instanceof RateLimitExceeded || err instanceof DDoSProtection) return 'RateLimited'
  if (err instanceof RequestTimeout) return 'NetworkError'
  if (err instanceof OnMaintenance || err instanceof ExchangeNotAvailable) return 'VenueUnavailable'
  if (err instanceof AuthenticationError || err instanceof PermissionDenied) return 'AuthError'
  if (err instanceof InsufficientFunds) return 'InsufficientBalance'
  if (err instanceof OrderNotFound) return 'NotFound' // must precede InvalidOrder (its parent)
  if (err instanceof InvalidOrder) return 'OrderRejected'
  return undefined
}

export function mapKucoinError(err: unknown, opts?: MapErrorOpts): AdapterError {
  // Already mapped (e.g. re-thrown through a lower layer) — don't double-wrap.
  if (err instanceof AdapterError) return err

  const rawCode = extractCode(err)
  const message = extractMessage(err)
  const reason = extractReason(err, message)

  // Message first, but for exactly one key: the venue reports "order does not exist" under its
  // generic parameter-error code, so the code table cannot express it (see NOT_FOUND_MESSAGE).
  if (NOT_FOUND_MESSAGE.test(reason) || NOT_FOUND_MESSAGE.test(message)) {
    return make('NotFound', message, rawCode, reason, err)
  }

  const byCode = rawCode !== undefined ? CODE_KIND.get(rawCode) : undefined
  if (byCode) return make(byCode, message, rawCode, reason, err)

  const byClass = mapByClass(err)
  if (byClass) return make(byClass, message, rawCode, reason, err)

  opts?.onUnknown?.(rawCode, err)
  return new NetworkError(message, { rawCode, reason, cause: err })
}
