/**
 * Bitget venue-error mapping (`10_exchange_adapters_and_market_data.md` §5). Turns any
 * ccxt/native throw into exactly one {@link AdapterError} — the core only ever sees one of
 * eight kinds, never a raw venue code. Mapping tables are adapter-local; the union is shared
 * (task 0200 decision 5), so this file mirrors `../okx/error-map.ts` structurally and only the
 * table and the code extraction differ.
 *
 * Resolution order (same as the siblings):
 *  1. **Venue code wins** — read off the error object, else parsed out of the message.
 *  2. **ccxt class** — `instanceof`, most-specific subclass first (`OrderNotFound` before its
 *     `InvalidOrder` parent, else a not-found would read as a rejection).
 *  3. **Unknown → `NetworkError`** (retryable), raw code captured on the error and handed to
 *     `opts.onUnknown` so the adapter logs it. Never a raw re-throw.
 *
 * Bitget quirks — the code is a **string** and the table is keyed by that string rather than a
 * parsed number, because this venue's success envelope is **`"00000"`**, which would collapse
 * onto `0` numerically. There are two success values, not one: REST answers `"00000"`, the WS
 * trade API answers `"0"` (see `./ws-orders.ts`); both are envelope values, never error codes.
 *
 * The table is deliberately small and sourced: it carries the codes the Bitget docs publish for
 * the paths this adapter drives. Task 0440 Phase 2 (`2c`) feeds every reject code actually
 * observed on the demo account back into it — until then, an unlisted code maps to a retryable
 * `NetworkError` **and is logged**, which is the honest posture rather than a guessed table.
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
 * Bitget error code → kind (`10` §5; Bitget public error-code reference). Codes are strings on
 * the wire and stay strings here. HTTP `429` sits alongside the venue codes because the edge
 * answers IP-rate abuse before any venue `code` exists.
 */
const CODE_KIND = new Map<string, VenueErrorKind>([
  ['429', 'RateLimited'], // edge rejection on request-rate abuse (no venue code)
  // ── v3 / UTA code space (`25xxx`) — the surface this adapter actually drives. Added in
  //    task 0440 Phase 2 against the live demo account: a cancel of a never-placed
  //    `clientOid` answers **`25204`**, which the v2-era rows below would have mis-classified
  //    as a retryable `NetworkError`. Codes from the UTA REST error-code reference.
  ['25000', 'VenueUnavailable'], // system error, try again later
  ['25001', 'NetworkError'], // operation timed out — order status unknown, retryable
  ['25003', 'NetworkError'], // concurrent operation, please retry
  ['25004', 'RateLimited'], // operation too frequent
  ['25100', 'OrderRejected'], // trading pair does not exist
  ['25101', 'OrderRejected'], // trading pair not open for trading
  ['25102', 'OrderRejected'], // trading pair closed for maintenance
  ['25104', 'OrderRejected'], // contract delisted
  ['25200', 'OrderRejected'], // parameter validation error
  ['25202', 'InsufficientBalance'], // insufficient balance
  ['25203', 'InsufficientBalance'], // insufficient margin
  ['25204', 'NotFound'], // order does not exist — cancel/read of an unknown order
  ['25205', 'OrderRejected'], // price below the venue's band
  ['25206', 'OrderRejected'], // price above the venue's band
  ['25207', 'OrderRejected'], // quantity below the minimum
  ['25208', 'OrderRejected'], // quantity above the maximum
  ['25211', 'OrderRejected'], // exceeds the maximum open-order count
  ['25212', 'OrderRejected'], // duplicate clientOid — the idempotency collision
  ['25230', 'OrderRejected'], // order quantity exceeds the maximum
  ['25244', 'OrderRejected'], // price must be a multiple of the tick
  ['25245', 'AuthError'], // not in unified account mode — the UTA precondition, never retryable
  ['25620', 'AuthError'], // permission denied
  // ── WS trade-API code space. The **same** venue, a **different** code space: the WS-API
  //    error frame answers a tick-grid violation with `43028`, where the REST surface would
  //    answer `25244` (observed live, task 0440 Phase 2). Both are tabled, so one mapper
  //    classifies either surface.
  ['43027', 'OrderRejected'], // order value below the venue minimum (5 USDT)
  ['43028', 'OrderRejected'], // price is not an integer multiple of the tick
  ['45111', 'OrderRejected'], // quantity below the symbol's minimum
  ['40763', 'OrderRejected'], // exceeds the position-tier limit
  ['50060', 'OrderRejected'], // duplicated clientOid — the WS-API idempotency collision
  // ── v2-era codes: still reachable through any ccxt path that has no UTA branch.
  ['30001', 'RateLimited'], // WS: request too frequent
  ['40010', 'NetworkError'], // request timed out — order status unknown, retryable
  ['40200', 'VenueUnavailable'], // server upgrading, retry later
  ['40725', 'VenueUnavailable'], // service returned an error
  ['40001', 'AuthError'], // ACCESS_KEY cannot be empty
  ['40002', 'AuthError'], // ACCESS_SIGN cannot be empty
  ['40003', 'AuthError'], // ACCESS_TIMESTAMP cannot be empty
  ['40004', 'AuthError'], // request timestamp expired
  ['40005', 'AuthError'], // invalid ACCESS_TIMESTAMP
  ['40006', 'AuthError'], // invalid ACCESS_KEY
  ['40009', 'AuthError'], // signature error
  ['40011', 'AuthError'], // ACCESS_PASSPHRASE cannot be empty — the Bitget/OKX third credential
  ['40012', 'AuthError'], // apikey or passphrase incorrect
  ['40013', 'AuthError'], // user status abnormal
  ['40014', 'AuthError'], // incorrect permissions on this API key
  ['40018', 'AuthError'], // invalid IP (key IP allowlist)
  ['40035', 'AuthError'], // identity verification (KYC) required for this action
  ['40037', 'AuthError'], // apikey does not exist
  ['43012', 'InsufficientBalance'], // insufficient balance
  ['40768', 'NotFound'], // order does not exist
  ['22001', 'NotFound'], // no order to cancel
  ['43025', 'NotFound'], // plan order does not exist
  ['40017', 'OrderRejected'], // parameter verification failed
  ['40305', 'OrderRejected'], // client_oid malformed / over length
  ['40309', 'OrderRejected'], // symbol has been removed
  ['40762', 'OrderRejected'], // order size greater than the max open size
  ['40808', 'OrderRejected'], // parameter verification exception
  ['43011', 'OrderRejected'], // parameter verification failed
  ['45110', 'OrderRejected'], // below the venue's minimum order notional
])

/**
 * Envelope codes that are not error codes: REST success is `"00000"`, the WS trade API's
 * success is `"0"`. Neither may ever be looked up in {@link CODE_KIND}.
 */
const ENVELOPE_CODES = new Set(['00000', '0'])

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

/** A Bitget code as the wire spells it, ignoring the two success envelopes. */
function toCode(raw: unknown): string | undefined {
  const code = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (code.length === 0 || ENVELOPE_CODES.has(code)) return undefined
  return code
}

/** The venue envelope the native SDK nests under `body` when it throws on a non-2xx response. */
function bodyOf(err: unknown): Record<string, unknown> | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const body = (err as { body?: unknown }).body
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : undefined
}

/**
 * Read a Bitget code, **nested envelope first**. The native `RestClientV3` throws
 * `{ code: 400, message: 'Bad Request', body: { code: '25204', msg: … } }` — the top-level
 * `code` is the **HTTP status**, not a venue code, so reading it first would classify every
 * rejection as the same unknown (confirmed live, task 0440 Phase 2). After the body come the
 * shapes that do put the venue code at the top level (the WS trade API's error frame, ccxt's
 * own `code`), then whatever the ccxt message embeds (`bitget {"code":"43012",…}`), then a bare
 * 5-digit run as a last resort.
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
  // Bitget codes are 5-digit and positive; a narrow pattern avoids matching a price or a
  // quantity that happens to appear in the message text.
  const bare = msg.match(/\b\d{5}\b/)
  return bare ? toCode(bare[0]) : undefined
}

/** The human reason Bitget ships beside the code (`msg` on every envelope and error frame). */
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

export function mapBitgetError(err: unknown, opts?: MapErrorOpts): AdapterError {
  // Already mapped (e.g. re-thrown through a lower layer) — don't double-wrap.
  if (err instanceof AdapterError) return err

  const rawCode = extractCode(err)
  const message = extractMessage(err)
  const reason = extractReason(err, message)

  const byCode = rawCode !== undefined ? CODE_KIND.get(rawCode) : undefined
  if (byCode) return make(byCode, message, rawCode, reason, err)

  const byClass = mapByClass(err)
  if (byClass) return make(byClass, message, rawCode, reason, err)

  opts?.onUnknown?.(rawCode, err)
  return new NetworkError(message, { rawCode, reason, cause: err })
}
