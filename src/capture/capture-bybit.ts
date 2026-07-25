/**
 * Bybit capture drivers (task 0420, mirroring `./capture-binance.ts`). Each set drives the
 * **real** ccxt/native clients (`src/adapters/exchanges/bybit/factory.ts`) — never a fake —
 * collects raw payloads exactly as the adapter receives them (pre-scrub), scrubs in-memory,
 * and writes deterministic fixtures under `test/fixtures/bybit/<set>/`. Fail-loud when
 * required creds are absent (mirrors the integration-gate convention: skip, don't silently
 * do nothing).
 *
 * `markets`/`public-ws` are credential-free (public REST/WS). `private-ws`/`orders` require
 * testnet keys and never touch the account beyond one far-from-market limit order that is
 * immediately cancelled.
 *
 * Bybit divergences from the Binance driver:
 *  - one ccxt class for every category (`ccxt.bybit`, `defaultType: 'swap'`);
 *  - the funding interval ships inside `market.info.fundingInterval` in **minutes**
 *    (480 → 8 h, 240 → 4 h — the majority case, 0 on the dated `LinearFutures` rows), so a
 *    real 4 h row is capturable here where the Binance set had to synthesize one;
 *  - WS frames arrive on the native SDK's single `'update'` event for every topic (there is
 *    no Binance-style `formattedMessage`/`formattedUserDataMessage` split), and the public
 *    funding/tick signal is one `tickers.<SYMBOL>` topic per symbol — no all-symbol stream;
 *  - the order read by client id goes through `fetchOpenOrders(symbol, …, { orderLinkId })`:
 *    ccxt's `fetchOrder` hard-binds the venue `orderId` on Bybit.
 */

import { WebsocketClient } from 'bybit-api'
import { bybit } from 'ccxt'
import { createRealClock } from '../adapters/clock/real-clock.js'
import { createBybitClients } from '../adapters/exchanges/bybit/factory.js'
import type { ExchangeProfile } from '../config/exchange-schema.js'
import { makeClientOrderId } from '../core/order-id/client-order-id.js'
import { writeJsonFixture, writeJsonlFixture } from './fixture-writer.js'
import { writeManifest } from './manifest.js'
import { createScrubMaps, scrub } from './scrub.js'

const FIXTURES_ROOT = 'test/fixtures/bybit'

/** Linear USDT perpetuals — the only category the adapter (and so this capture) speaks. */
const CATEGORY = 'linear' as const

/**
 * Fees/stagger/rate-limit fields are unused by capture (no order-cost math); the
 * factory signature requires a full {@link ExchangeProfile} regardless.
 */
const PLACEHOLDER_PROFILE: ExchangeProfile = {
  takerFeePct: 0.055,
  makerFeePct: 0.02,
  submissionStaggerMs: 100,
  rateLimitReservePct: 10,
  rateLimitWeightPerMinute: 6000,
  wsOrderAdapter: true,
  ws: { publicUrl: 'wss://stream.bybit.com/v5/public/linear', privateUrl: 'wss://stream.bybit.com/v5/private' },
  deltas: {},
}

function requireTestnetCreds(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.BYBIT_TESTNET_API_KEY
  const apiSecret = process.env.BYBIT_TESTNET_API_SECRET
  if (!apiKey || !apiSecret) {
    throw new Error('capture: BYBIT_TESTNET_API_KEY / BYBIT_TESTNET_API_SECRET required for this set (testnet only)')
  }
  return { apiKey, apiSecret }
}

// ── markets (public, no creds) ─────────────────────────────────────────────────

/**
 * Venue ids a healthy live market genuinely emits — clean 8 h perp, a 4 h perp (Bybit's
 * majority funding cadence) and a 1000x multiplier listing.
 */
const CAPTURABLE_MARKETS: readonly { readonly id: string; readonly stem: string }[] = [
  { id: 'BTCUSDT', stem: 'clean-perp-btc' },
  { id: 'TIAUSDT', stem: 'funding-4h-tia' },
  { id: '1000PEPEUSDT', stem: 'multiplier-pepe' },
]

/**
 * Hand-authored, irreducibly synthetic sibling fixtures — no healthy live listing emits
 * these shapes (spot/inverse/dated come from other ccxt categories; the anomalies are
 * deliberately malformed; the collision + 1e4/1e6-multiplier rows exercise edges not worth
 * chasing a live listing for). Left as authored JSON, listed here so `captureMarkets` can
 * record them in the manifest.
 */
const SYNTHETIC_MARKETS: readonly string[] = [
  'spot-btc',
  'inverse-coinm',
  'dated-expiry',
  'delisted',
  'anomaly-bad-funding',
  'anomaly-zero-funding',
  'anomaly-missing-precision',
  'anomaly-zero-contractsize',
  'anomaly-unparsable-base',
  'multiplier-cat',
  'plain-cat',
  'multiplier-sats',
  'multiplier-mog',
]

export async function captureMarkets(outDir: string = `${FIXTURES_ROOT}/markets`): Promise<void> {
  // No credentials at all, deliberately: with keys set, ccxt's `loadMarkets` also calls
  // `fetchCurrencies`, which on Bybit is a **private** endpoint (`retCode 10003` with a
  // placeholder key). Unauthenticated, it is skipped and the market read stays public.
  const ccxt = new bybit({ enableRateLimit: true, options: { defaultType: 'swap' } })
  const markets = await ccxt.loadMarkets()
  const byVenueId = new Map(Object.values(markets).map((m) => [m?.id, m]))

  const maps = createScrubMaps()
  let count = 0
  for (const { id, stem } of CAPTURABLE_MARKETS) {
    const market = byVenueId.get(id)
    if (!market) throw new Error(`capture markets: venue no longer lists '${id}' — update CAPTURABLE_MARKETS`)
    writeJsonFixture(`${outDir}/${stem}.json`, scrub(market, maps, { normalizeVolatile: false }))
    count++
  }

  writeManifest({
    dir: outDir,
    set: 'markets',
    venue: 'bybit',
    network: 'prod',
    capturedAtMs: Date.now(),
    source: 'ccxt.bybit#loadMarkets (public /v5/market/instruments-info)',
    count,
    synthetic: SYNTHETIC_MARKETS,
  })
}

// ── public-ws (public, no creds) ───────────────────────────────────────────────

export interface PublicWsCaptureOptions {
  readonly symbols?: readonly string[]
  readonly count?: number
  readonly windowMs?: number
  readonly outDir?: string
}

/** Venue symbols (not canonical names): the `tickers` topic is case-sensitive and venue-shaped. */
const DEFAULT_PUBLIC_WS_SYMBOLS = ['BTCUSDT']
const DEFAULT_PUBLIC_WS_COUNT = 20
const DEFAULT_PUBLIC_WS_WINDOW_MS = 20_000

/**
 * Subscribe the public `tickers.<SYMBOL>` feeds and collect raw `'update'` frames until
 * `count` or `windowMs`. One topic carries both signals (funding + last price), and every
 * frame after the first `snapshot` is a **delta** — capturing a window gets both shapes.
 */
export async function capturePublicWs(opts: PublicWsCaptureOptions = {}): Promise<void> {
  const outDir = opts.outDir ?? `${FIXTURES_ROOT}/public-ws`
  const symbols = opts.symbols ?? DEFAULT_PUBLIC_WS_SYMBOLS
  const count = opts.count ?? DEFAULT_PUBLIC_WS_COUNT
  const windowMs = opts.windowMs ?? DEFAULT_PUBLIC_WS_WINDOW_MS

  const ws = new WebsocketClient({})
  const frames: unknown[] = []
  ws.on('update', (msg) => frames.push(msg))

  const topics = symbols.map((s) => `tickers.${s}`)
  await Promise.all(ws.subscribeV5(topics, CATEGORY))

  await new Promise<void>((resolve) => {
    const started = Date.now()
    const poll = setInterval(() => {
      if (frames.length >= count || Date.now() - started > windowMs) {
        clearInterval(poll)
        resolve()
      }
    }, 250)
  })
  ws.closeAll(true)

  const maps = createScrubMaps()
  const scrubbed = frames.map((f) => scrub(f, maps))
  writeJsonlFixture(`${outDir}/frames.jsonl`, scrubbed)
  writeManifest({
    dir: outDir,
    set: 'public-ws',
    venue: 'bybit',
    network: 'prod',
    capturedAtMs: Date.now(),
    source: `bybit WebsocketClient 'update' — ${topics.join(',')} (${CATEGORY})`,
    count: scrubbed.length,
  })
}

// ── private-ws (testnet, env-gated) ────────────────────────────────────────────

export interface PrivateWsCaptureOptions {
  readonly windowMs?: number
  readonly outDir?: string
}

const DEFAULT_PRIVATE_WS_WINDOW_MS = 20_000

/** The four private topics the adapter subscribes (`11` §7) — one credentialed connection. */
const PRIVATE_TOPICS = ['order', 'execution', 'position', 'wallet']

/** Subscribe the private topics and collect whatever `'update'` frames arrive in the window. */
export async function capturePrivateWs(opts: PrivateWsCaptureOptions = {}): Promise<void> {
  const outDir = opts.outDir ?? `${FIXTURES_ROOT}/private-ws`
  const windowMs = opts.windowMs ?? DEFAULT_PRIVATE_WS_WINDOW_MS
  const { apiKey, apiSecret } = requireTestnetCreds()

  const { wsPrivate: ws } = createBybitClients(PLACEHOLDER_PROFILE, { apiKey, apiSecret }, { network: 'testnet' })
  const frames: unknown[] = []
  ws.on('update', (msg) => frames.push(msg))

  await Promise.all(ws.subscribeV5(PRIVATE_TOPICS, CATEGORY, true))
  await new Promise<void>((resolve) => setTimeout(resolve, windowMs))
  ws.closeAll(true)

  const maps = createScrubMaps()
  const scrubbed = frames.map((f) => scrub(f, maps))
  writeJsonlFixture(`${outDir}/frames.jsonl`, scrubbed)
  writeManifest({
    dir: outDir,
    set: 'private-ws',
    venue: 'bybit',
    network: 'testnet',
    capturedAtMs: Date.now(),
    source: `bybit WebsocketClient 'update' — private topics ${PRIVATE_TOPICS.join(',')}`,
    count: scrubbed.length,
  })
}

// ── orders (testnet, env-gated) ────────────────────────────────────────────────

const FAR_FROM_MARKET_PRICE = 20_000 // BTC limit far below market — rests, never fills
const ORDER_QTY = 0.001 // Bybit BTCUSDT min qty; qty × price ≥ 5 (min notional) at the fixed test price

export async function captureOrders(outDir: string = `${FIXTURES_ROOT}/orders`): Promise<void> {
  const { apiKey, apiSecret } = requireTestnetCreds()
  const clock = createRealClock()

  const { ccxt, wsApiPrivate: wsApi } = createBybitClients(
    PLACEHOLDER_PROFILE,
    { apiKey, apiSecret },
    { network: 'testnet' },
  )

  const clientOrderId = makeClientOrderId({ intentId: `capture-${clock.now()}`, leg: 'entry', attempt: 1 })
  const venueSymbol = 'BTCUSDT'

  const submitRes = await wsApi.submitNewOrder({
    category: CATEGORY,
    symbol: venueSymbol,
    side: 'Buy',
    orderType: 'Limit',
    qty: String(ORDER_QTY),
    price: String(FAR_FROM_MARKET_PRICE),
    timeInForce: 'GTC',
    orderLinkId: clientOrderId,
    positionIdx: 0,
  })

  // ccxt's `fetchOrder` hard-binds the venue `orderId` on Bybit, so the client-id read is
  // `fetchOpenOrders` + `orderLinkId` → `/v5/order/realtime` (what the adapter does).
  const orders = await ccxt.fetchOpenOrders('BTC/USDT:USDT', undefined, undefined, { orderLinkId: clientOrderId })

  const cancelRes = await wsApi.cancelOrder({
    category: CATEGORY,
    symbol: venueSymbol,
    orderLinkId: clientOrderId,
  })

  const maps = createScrubMaps() // shared across all three so the one clientOrderId scrubs consistently
  writeJsonFixture(`${outDir}/ws-submit.json`, scrub(submitRes, maps))
  writeJsonFixture(`${outDir}/ccxt-order.json`, scrub(orders[0], maps))
  writeJsonFixture(`${outDir}/ws-cancel.json`, scrub(cancelRes, maps))

  writeManifest({
    dir: outDir,
    set: 'orders',
    venue: 'bybit',
    network: 'testnet',
    capturedAtMs: clock.now(),
    source:
      'WebsocketAPIClient submitNewOrder/cancelOrder + ccxt fetchOpenOrders(orderLinkId) — one far-from-market limit, immediately cancelled',
    count: 3,
  })
}
