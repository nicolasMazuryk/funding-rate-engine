/**
 * Binance capture drivers (task 0250). Each set drives the **real** ccxt/native
 * clients (`src/adapters/exchanges/binance/factory.ts`) — never a fake — collects
 * raw payloads exactly as the adapter receives them (post-`beautify`, pre-scrub),
 * scrubs in-memory, and writes deterministic fixtures under
 * `test/fixtures/binance/<set>/`. Fail-loud when required creds are absent (mirrors
 * the integration-gate convention: skip, don't silently do nothing).
 *
 * `markets`/`public-ws` are credential-free (public REST/WS). `private-ws`/`orders`
 * require testnet keys and never touch the account beyond one far-from-market
 * limit order that is immediately cancelled.
 */

import { WebsocketClient } from 'binance'
import { binanceusdm } from 'ccxt'
import { createRealClock } from '../adapters/clock/real-clock.js'
import { createBinanceClients } from '../adapters/exchanges/binance/factory.js'
import type { ExchangeProfile } from '../config/exchange-schema.js'
import { makeClientOrderId } from '../core/order-id/client-order-id.js'
import { writeJsonFixture, writeJsonlFixture } from './fixture-writer.js'
import { writeManifest } from './manifest.js'
import { createScrubMaps, scrub } from './scrub.js'

const FIXTURES_ROOT = 'test/fixtures/binance'

/**
 * Fees/stagger/rate-limit fields are unused by capture (no order-cost math); the
 * factory signature requires a full {@link ExchangeProfile} regardless.
 */
const PLACEHOLDER_PROFILE: ExchangeProfile = {
  takerFeePct: 0.05,
  makerFeePct: 0.02,
  submissionStaggerMs: 100,
  rateLimitReservePct: 10,
  rateLimitWeightPerMinute: 2400,
  wsOrderAdapter: true,
  ws: { publicUrl: 'wss://fstream.binance.com/ws', privateUrl: 'wss://fstream.binance.com/ws' },
  deltas: {},
}

function requireTestnetCreds(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.BINANCE_TESTNET_API_KEY
  const apiSecret = process.env.BINANCE_TESTNET_API_SECRET
  if (!apiKey || !apiSecret) {
    throw new Error(
      'capture: BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET required for this set (testnet only)',
    )
  }
  return { apiKey, apiSecret }
}

// ── markets (public, no creds) ─────────────────────────────────────────────────

/** Venue ids a healthy live market genuinely emits — clean perp + 1000x multiplier (plan §"Decisions" 1). */
const CAPTURABLE_MARKETS: readonly { readonly id: string; readonly stem: string }[] = [
  { id: 'BTCUSDT', stem: 'clean-perp-btc' },
  { id: 'ETHUSDT', stem: 'clean-perp-eth' },
  { id: '1000PEPEUSDT', stem: 'multiplier-pepe' },
]

/**
 * Hand-authored, irreducibly synthetic sibling fixtures (`plan.md` §"Decisions" 1) — no
 * healthy live/testnet market emits these shapes (spot/inverse/dated/delisted come from
 * other ccxt classes; funding-4h because ccxt doesn't populate the interval today;
 * anomalies are deliberately malformed; multiplier-cat/plain-cat/multiplier-mog exercise
 * collision/1e6-multiplier edge cases not worth chasing a live listing for). Left as
 * authored JSON, listed here so `captureMarkets` can record them in the manifest.
 */
const SYNTHETIC_MARKETS: readonly string[] = [
  'spot-btc',
  'inverse-coinm',
  'dated-expiry',
  'delisted',
  'funding-4h',
  'anomaly-bad-funding',
  'anomaly-missing-precision',
  'anomaly-zero-contractsize',
  'multiplier-cat',
  'plain-cat',
  'multiplier-mog',
]

export async function captureMarkets(outDir: string = `${FIXTURES_ROOT}/markets`): Promise<void> {
  const ccxt = new binanceusdm({
    apiKey: 'public',
    secret: 'public',
    enableRateLimit: true,
    options: { defaultType: 'swap', fetchCurrencies: false },
  })
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
    venue: 'binance',
    network: 'prod',
    capturedAtMs: Date.now(),
    source: 'ccxt.binanceusdm#loadMarkets (public futures exchangeInfo)',
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

const DEFAULT_PUBLIC_WS_SYMBOLS = ['BTC']
const DEFAULT_PUBLIC_WS_COUNT = 20
const DEFAULT_PUBLIC_WS_WINDOW_MS = 20_000

/** Subscribe the public feeds and collect raw `formattedMessage` frames until `count` or `windowMs`. */
export async function capturePublicWs(opts: PublicWsCaptureOptions = {}): Promise<void> {
  const outDir = opts.outDir ?? `${FIXTURES_ROOT}/public-ws`
  const symbols = opts.symbols ?? DEFAULT_PUBLIC_WS_SYMBOLS
  const count = opts.count ?? DEFAULT_PUBLIC_WS_COUNT
  const windowMs = opts.windowMs ?? DEFAULT_PUBLIC_WS_WINDOW_MS

  const ws = new WebsocketClient({ beautify: true })
  const frames: unknown[] = []
  ws.on('formattedMessage', (msg) => frames.push(msg))

  await ws.subscribe('!markPrice@arr@1s', 'usdmMarket')
  await ws.subscribe(
    symbols.map((s) => `${s.toLowerCase()}usdt@aggTrade`),
    'usdmMarket',
  )

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
    venue: 'binance',
    network: 'prod',
    capturedAtMs: Date.now(),
    source: `binance WebsocketClient formattedMessage — !markPrice@arr@1s + ${symbols.join(',')}@aggTrade`,
    count: scrubbed.length,
  })
}

// ── private-ws (testnet, env-gated) ────────────────────────────────────────────

export interface PrivateWsCaptureOptions {
  readonly windowMs?: number
  readonly outDir?: string
}

const DEFAULT_PRIVATE_WS_WINDOW_MS = 20_000

/** Subscribe the user-data stream and collect whatever `formattedUserDataMessage` frames arrive in the window. */
export async function capturePrivateWs(opts: PrivateWsCaptureOptions = {}): Promise<void> {
  const outDir = opts.outDir ?? `${FIXTURES_ROOT}/private-ws`
  const windowMs = opts.windowMs ?? DEFAULT_PRIVATE_WS_WINDOW_MS
  const { apiKey, apiSecret } = requireTestnetCreds()

  const { wsPrivate: ws } = createBinanceClients(PLACEHOLDER_PROFILE, { apiKey, apiSecret }, { network: 'testnet' })
  const frames: unknown[] = []
  ws.on('formattedUserDataMessage', (msg) => frames.push(msg))

  await ws.subscribeUsdFuturesUserDataStream()
  await new Promise<void>((resolve) => setTimeout(resolve, windowMs))
  ws.closeAll(true)

  const maps = createScrubMaps()
  const scrubbed = frames.map((f) => scrub(f, maps))
  writeJsonlFixture(`${outDir}/frames.jsonl`, scrubbed)
  writeManifest({
    dir: outDir,
    set: 'private-ws',
    venue: 'binance',
    network: 'testnet',
    capturedAtMs: Date.now(),
    source: 'binance WebsocketClient formattedUserDataMessage (USD-M user-data stream)',
    count: scrubbed.length,
  })
}

// ── orders (testnet, env-gated) ────────────────────────────────────────────────

const FAR_FROM_MARKET_PRICE = 20_000 // BTC limit far below market — rests, never fills
const ORDER_QTY = 0.003 // qty × price ≥ 50 (min notional) at the fixed test price above

export async function captureOrders(outDir: string = `${FIXTURES_ROOT}/orders`): Promise<void> {
  const { apiKey, apiSecret } = requireTestnetCreds()
  const clock = createRealClock()

  const { ccxt, wsApiPrivate: wsApi } = createBinanceClients(
    PLACEHOLDER_PROFILE,
    { apiKey, apiSecret },
    { network: 'testnet' },
  )

  const clientOrderId = makeClientOrderId({ intentId: `capture-${clock.now()}`, leg: 'entry', attempt: 1 })
  const venueSymbol = 'BTCUSDT'

  const submitRes = await wsApi.submitNewFuturesOrder('usdm', {
    symbol: venueSymbol,
    side: 'BUY',
    type: 'LIMIT',
    quantity: String(ORDER_QTY),
    price: String(FAR_FROM_MARKET_PRICE),
    timeInForce: 'GTC',
    newClientOrderId: clientOrderId,
    newOrderRespType: 'RESULT',
    timestamp: clock.now(),
  })

  const order = await ccxt.fetchOrder(clientOrderId, 'BTC/USDT:USDT', { clientOrderId })

  const cancelRes = await wsApi.cancelFuturesOrder('usdm', {
    symbol: venueSymbol,
    origClientOrderId: clientOrderId,
    timestamp: clock.now(),
  })

  const maps = createScrubMaps() // shared across all three so the one clientOrderId scrubs consistently
  writeJsonFixture(`${outDir}/ws-submit.json`, scrub(submitRes, maps))
  writeJsonFixture(`${outDir}/ccxt-order.json`, scrub(order, maps))
  writeJsonFixture(`${outDir}/ws-cancel.json`, scrub(cancelRes, maps))

  writeManifest({
    dir: outDir,
    set: 'orders',
    venue: 'binance',
    network: 'testnet',
    capturedAtMs: clock.now(),
    source: 'WebsocketAPIClient submit/cancel + ccxt fetchOrder — one far-from-market limit, immediately cancelled',
    count: 3,
  })
}
