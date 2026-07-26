/**
 * OKX venue-error mapping (`10_exchange_adapters_and_market_data.md` §5). Turns any
 * ccxt/native throw into exactly one {@link AdapterError} — the core only ever sees one of
 * eight kinds, never a raw venue code. Mapping tables are adapter-local; the union is
 * shared (task 0200 decision 5), so this file mirrors `../bybit/error-map.ts` structurally
 * and only the table and the code extraction differ.
 *
 * Resolution order (same as the siblings):
 *  1. **Venue code wins** — read off the error object, else parsed out of the message.
 *  2. **ccxt class** — `instanceof`, most-specific subclass first (`OrderNotFound` before
 *     its `InvalidOrder` parent, else a not-found would read as a rejection).
 *  3. **Unknown → `NetworkError`** (retryable), raw code captured on the error and handed
 *     to `opts.onUnknown` so the adapter logs it. Never a raw re-throw.
 *
 * OKX quirk — the code is a **string** and lives at one of two depths. A transport-level
 * failure carries a top-level `code` (`"50011"`); a per-order failure carries the useless
 * envelope `code: "1"` ("operation failed") with the real reason one level down at
 * `data[0].sCode` / `sMsg`. Success is `sCode: "0"`. So `"0"` and `"1"` are never treated
 * as codes, and `sCode` is read before `code`. That is a third distinct reject shape:
 * Binance nests at `err.error.code`, Bybit uses a flat numeric `retCode`.
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
 * OKX v5 error code → kind (`10` §5; OKX v5 error-code reference). Codes are strings on the
 * wire; the table is keyed numerically after parsing, since every OKX code is numeric.
 * HTTP 429 sits alongside the venue codes because Cloudflare answers IP-rate abuse before
 * any `code` exists.
 */
const CODE_KIND = new Map<number, VenueErrorKind>([
  [429, 'RateLimited'], // edge rejection on IP-rate abuse (no venue code)
  [50011, 'RateLimited'], // rate limit reached
  [50061, 'RateLimited'], // sub-account order rate limit (1000 req/2 s) exceeded
  [60014, 'RateLimited'], // WS: requests too frequent
  [50004, 'NetworkError'], // endpoint request timeout — order status unknown, retryable
  [50001, 'VenueUnavailable'], // service temporarily unavailable
  [50013, 'VenueUnavailable'], // system busy, retry later
  [50026, 'VenueUnavailable'], // system error, retry later
  [63999, 'VenueUnavailable'], // WS: internal system error
  [50100, 'AuthError'], // API frozen (contact support)
  [50101, 'AuthError'], // APIKey does not match the current environment (demo vs live)
  [50102, 'AuthError'], // timestamp request expired
  [50103, 'AuthError'], // OK-ACCESS-KEY header missing
  [50104, 'AuthError'], // OK-ACCESS-PASSPHRASE header missing — the OKX-only credential
  [50105, 'AuthError'], // invalid OK-ACCESS-PASSPHRASE
  [50106, 'AuthError'], // OK-ACCESS-SIGN header missing
  [50111, 'AuthError'], // invalid OK-ACCESS-KEY
  [50113, 'AuthError'], // invalid signature
  [50114, 'AuthError'], // invalid authorization
  [60004, 'AuthError'], // WS: invalid timestamp
  [60005, 'AuthError'], // WS: invalid apiKey
  [60006, 'AuthError'], // WS: timestamp expired
  [60007, 'AuthError'], // WS: invalid sign
  [60009, 'AuthError'], // WS: login failed
  [60022, 'AuthError'], // WS: not logged in
  [51004, 'InsufficientBalance'], // order amount exceeds the current tier's max open amount
  [51008, 'InsufficientBalance'], // insufficient account balance
  [51127, 'InsufficientBalance'], // available balance is 0
  [51131, 'InsufficientBalance'], // insufficient balance
  [51001, 'NotFound'], // instrument ID does not exist
  [51400, 'NotFound'], // cancellation failed — order does not exist
  [51603, 'NotFound'], // order does not exist (query/amend by clOrdId)
  [51000, 'OrderRejected'], // parameter error (precision / bad field)
  [51005, 'OrderRejected'], // order amount exceeds the maximum
  [51006, 'OrderRejected'], // order price outside the venue's limit range
  [51020, 'OrderRejected'], // order amount below the minimum (minSz)
  [51121, 'OrderRejected'], // order quantity is not a multiple of the lot size
  [51205, 'OrderRejected'], // reduce-only not available for this position mode
  [59000, 'OrderRejected'], // settings (leverage / margin mode) failed — close positions first
])

/** Envelope codes that are not error codes: `"0"` = success, `"1"` = "operation failed", reason nested. */
const ENVELOPE_CODES = new Set([0, 1])

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

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  return String(err)
}

/** A numeric OKX code, ignoring the `"0"`/`"1"` envelope values. */
function toCode(raw: unknown): number | undefined {
  const parsed = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  if (!Number.isFinite(parsed) || ENVELOPE_CODES.has(parsed)) return undefined
  return parsed
}

/** The per-order code buried at `data[0].sCode` — where a `code: "1"` reply keeps its reason. */
function extractNestedCode(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object' || !('data' in err)) return undefined
  const data = (err as { data?: unknown }).data
  if (!Array.isArray(data)) return undefined
  for (const entry of data) {
    if (entry !== null && typeof entry === 'object' && 'sCode' in entry) {
      const code = toCode((entry as { sCode?: unknown }).sCode)
      if (code !== undefined) return code
    }
  }
  return undefined
}

/**
 * Read an OKX code: nested `data[0].sCode` first (a `code: "1"` envelope hides the real
 * reason there), then a lifted/native `sCode`/`code` on the object, then whatever the ccxt
 * message embeds (`okx {"code":"50011",…}` or a bare `"sCode":"51008"`).
 */
function extractCode(err: unknown): number | undefined {
  const nested = extractNestedCode(err)
  if (nested !== undefined) return nested
  if (typeof err === 'object' && err !== null) {
    for (const field of ['sCode', 'code'] as const) {
      if (field in err) {
        const code = toCode((err as Record<string, unknown>)[field])
        if (code !== undefined) return code
      }
    }
  }
  const msg = extractMessage(err)
  const inJson = msg.match(/"s?[Cc]ode"\s*:\s*"?(\d+)"?/)
  const fromJson = inJson?.[1] === undefined ? undefined : toCode(inJson[1])
  if (fromJson !== undefined) return fromJson
  // OKX codes are 5-digit and positive; a narrower pattern than Binance's avoids matching
  // a price or quantity that happens to appear in the message text.
  const bare = msg.match(/\b\d{5}\b/)
  return bare ? Number(bare[0]) : undefined
}

/** The human reason OKX ships beside the code (`sMsg` per order, `msg` per envelope). */
function extractReason(err: unknown, fallback: string): string {
  if (err !== null && typeof err === 'object') {
    const data = (err as { data?: unknown }).data
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (entry !== null && typeof entry === 'object') {
          const sMsg = (entry as { sMsg?: unknown }).sMsg
          if (typeof sMsg === 'string' && sMsg.length > 0) return sMsg
        }
      }
    }
    for (const field of ['sMsg', 'msg'] as const) {
      const raw = (err as Record<string, unknown>)[field]
      if (typeof raw === 'string' && raw.length > 0) return raw
    }
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

export function mapOkxError(err: unknown, opts?: MapErrorOpts): AdapterError {
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
