/**
 * Bitget capture drivers (task 0440, mirroring `./capture-okx.ts`). Each set drives the
 * **real** ccxt/native clients (`src/adapters/exchanges/bitget/factory.ts`) — never a fake —
 * collects raw payloads exactly as the adapter receives them (pre-scrub), scrubs in-memory,
 * and writes deterministic fixtures under `test/fixtures/bitget/<set>/`. Fail-loud when
 * required creds are absent (mirrors the integration-gate convention: skip, don't silently do
 * nothing).
 *
 * `markets`/`public-ws` are credential-free (public REST/WS). `private-ws`/`orders` require
 * demo-trading keys and never touch the account beyond one far-from-market limit order that
 * is immediately cancelled.
 *
 * Bitget divergences from the OKX driver:
 *  - the whole surface is **v3 / UTA** (`WebsocketClientV3`, `instType: 'UTA'` private topics),
 *    because that is the only surface the native WS order client speaks;
 *  - the funding interval **is** a market-metadata field (`info.fundInterval`, in hours), so
 *    unlike OKX the `markets` set needs no companion funding-rate read;
 *  - the public funding rate and the last price arrive on **one** `ticker` topic (Bybit's
 *    shape), not OKX's two channels;
 *  - orders carry `clientOid` (32-char cap, no re-spelling) and the WS trade API answers with
 *    `code: '0'`, while REST answers `code: '00000'`.
 */

import { WebsocketClientV3, WS_KEY_MAP } from 'bitget-api'
import { bitget } from 'ccxt'
import { createRealClock } from '../adapters/clock/real-clock.js'
import { createBitgetClients } from '../adapters/exchanges/bitget/factory.js'
import type { ExchangeProfile } from '../config/exchange-schema.js'
import { makeClientOrderId } from '../core/order-id/client-order-id.js'
import { writeJsonFixture, writeJsonlFixture } from './fixture-writer.js'
import { writeManifest } from './manifest.js'
import { createScrubMaps, scrub } from './scrub.js'

const FIXTURES_ROOT = 'test/fixtures/bitget'

/**
 * The linear-USDT category as the **WS trade API** spells it. Bitget uses two casings for the
 * same product: REST takes `USDT-FUTURES`, the WS surface (public `instType` and the WS-API
 * `category`) takes `usdt-futures`. Same on live and demo trading.
 */
const WS_CATEGORY = 'usdt-futures'

/**
 * Fees/stagger/rate-limit fields are unused by capture (no order-cost math); the factory
 * signature requires a full {@link ExchangeProfile} regardless.
 */
const PLACEHOLDER_PROFILE: ExchangeProfile = {
  takerFeePct: 0.06,
  makerFeePct: 0.02,
  submissionStaggerMs: 100,
  rateLimitReservePct: 33,
  rateLimitWeightPerMinute: 1800,
  wsOrderAdapter: true,
  ws: { publicUrl: 'wss://ws.bitget.com/v3/ws/public', privateUrl: 'wss://ws.bitget.com/v3/ws/private' },
  deltas: {},
}

interface BitgetCredentials {
  apiKey: string
  apiSecret: string
  apiPassphrase: string
}

function requireDemoCreds(): BitgetCredentials {
  const apiKey = process.env.BITGET_TESTNET_API_KEY
  const apiSecret = process.env.BITGET_TESTNET_API_SECRET
  const apiPassphrase = process.env.BITGET_TESTNET_PASSPHRASE
  if (!apiKey || !apiSecret || !apiPassphrase) {
    throw new Error(
      'capture: BITGET_TESTNET_API_KEY / BITGET_TESTNET_API_SECRET / BITGET_TESTNET_PASSPHRASE required for this set (demo trading only)',
    )
  }
  return { apiKey, apiSecret, apiPassphrase }
}

// ── markets (public, no creds) ─────────────────────────────────────────────────

/**
 * Venue ids a healthy live listing genuinely emits, chosen to cover what Bitget makes
 * load-bearing: the plain 8 h majority, both ends of the multiplier-prefix set (`1000`,
 * `1000000`), the 4 h cadence (373 of 721 symbols) and the rare 1 h one (3 symbols), plus a
 * base that starts with a digit but carries no multiplier (`1INCH`, the normalization trap).
 */
const CAPTURABLE_MARKETS: readonly { readonly id: string; readonly stem: string }[] = [
  { id: 'BTCUSDT', stem: 'clean-perp-btc' },
  { id: '1000BONKUSDT', stem: 'multiplier-1000-bonk' },
  { id: '1000000MOGUSDT', stem: 'multiplier-1000000-mog' },
  { id: 'XTZUSDT', stem: 'funding-4h-xtz' },
  { id: 'DEXEUSDT', stem: 'funding-1h-dexe' },
  { id: '1INCHUSDT', stem: 'digit-base-1inch' },
]

/**
 * Hand-authored, irreducibly synthetic sibling fixtures — no healthy live listing emits these
 * shapes (spot/inverse come from other instrument types; the anomalies are deliberately
 * malformed; `plain-bonk` is the collision partner for `1000BONKUSDT`, which the venue does
 * not list). Left as authored JSON, listed here so `captureMarkets` records them in the
 * manifest.
 */
const SYNTHETIC_MARKETS: readonly string[] = [
  'spot-btc',
  'inverse-coinm',
  'delisted',
  'anomaly-missing-precision',
  'anomaly-zero-contractsize',
  'anomaly-unparsable-base',
  'anomaly-contractsize-not-one',
  'plain-bonk',
]

/**
 * Capture the market rows. One read is enough on this venue: `info.fundInterval` carries the
 * funding cadence in hours, so — unlike OKX — no companion funding-rate read is needed to
 * express a non-8 h symbol.
 */
export async function captureMarkets(outDir: string = `${FIXTURES_ROOT}/markets`): Promise<void> {
  // No credentials at all, deliberately: the market read is public, and an unauthenticated
  // client cannot leak account material into a committed fixture.
  const ccxt = new bitget({ enableRateLimit: true, options: { defaultType: 'swap', uta: true } })
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
    venue: 'bitget',
    network: 'prod',
    capturedAtMs: Date.now(),
    source: 'ccxt.bitget#loadMarkets (public /api/v3/market/instruments, category USDT-FUTURES)',
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

/** Venue symbols (not canonical names): Bitget channel args are venue-shaped. */
const DEFAULT_PUBLIC_WS_SYMBOLS = ['BTCUSDT']
const DEFAULT_PUBLIC_WS_COUNT = 20
const DEFAULT_PUBLIC_WS_WINDOW_MS = 20_000

/** The v3 public `instType` for the linear-USDT universe (lower-case, unlike the REST category). */
const PUBLIC_INST_TYPE = WS_CATEGORY

/**
 * Subscribe the public `ticker` topic and collect raw `'update'` frames until `count` or
 * `windowMs`. **One** topic, not two: a Bitget futures ticker frame carries the last price
 * *and* the funding rate + next funding time, where OKX splits them across `tickers` and
 * `funding-rate`.
 */
export async function capturePublicWs(opts: PublicWsCaptureOptions = {}): Promise<void> {
  const outDir = opts.outDir ?? `${FIXTURES_ROOT}/public-ws`
  const symbols = opts.symbols ?? DEFAULT_PUBLIC_WS_SYMBOLS
  const count = opts.count ?? DEFAULT_PUBLIC_WS_COUNT
  const windowMs = opts.windowMs ?? DEFAULT_PUBLIC_WS_WINDOW_MS

  const ws = new WebsocketClientV3({})
  const frames: unknown[] = []
  ws.on('update', (msg) => frames.push(msg))

  await ws.subscribe(
    symbols.map((symbol) => ({ topic: 'ticker' as const, payload: { instType: PUBLIC_INST_TYPE, symbol } })),
    WS_KEY_MAP.v3Public,
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
    venue: 'bitget',
    network: 'prod',
    capturedAtMs: Date.now(),
    source: `bitget WebsocketClientV3 'update' — ticker (${PUBLIC_INST_TYPE}) for ${symbols.join(',')}`,
    count: scrubbed.length,
  })
}

// ── private-ws (demo trading, env-gated) ───────────────────────────────────────

export interface PrivateWsCaptureOptions {
  readonly windowMs?: number
  readonly outDir?: string
}

const DEFAULT_PRIVATE_WS_WINDOW_MS = 20_000

/** The four private UTA topics the adapter subscribes (`11` §7) — one credentialed connection. */
const PRIVATE_TOPICS = ['order', 'fill', 'position', 'account'] as const

/**
 * Subscribe the private topics and collect the `'update'` frames that arrive in the window.
 *
 * Unlike the sibling drivers this one **generates** the traffic it records: Bitget's UTA topics
 * push nothing at all on a quiet account (a passive 20 s window captured zero frames, task 0440
 * Phase 2), and an empty fixture cannot back a stream mapper. So the window contains one
 * far-from-market limit order, immediately cancelled — the same safe shape `captureOrders`
 * uses — which makes the `order` topic emit its live/cancelled rows.
 */
export async function capturePrivateWs(opts: PrivateWsCaptureOptions = {}): Promise<void> {
  const outDir = opts.outDir ?? `${FIXTURES_ROOT}/private-ws`
  const windowMs = opts.windowMs ?? DEFAULT_PRIVATE_WS_WINDOW_MS
  const creds = requireDemoCreds()

  const {
    wsPrivate: ws,
    wsApiPrivate: wsApi,
    ccxt,
  } = createBitgetClients(PLACEHOLDER_PROFILE, creds, { network: 'testnet' })
  const frames: unknown[] = []
  ws.on('update', (msg) => frames.push(msg))

  await ws.subscribe(
    PRIVATE_TOPICS.map((topic) => ({ topic, payload: { instType: 'UTA' as const } })),
    WS_KEY_MAP.v3Private,
  )

  const clientOid = makeClientOrderId({ intentId: `cap-${Date.now()}`, leg: 'entry', attempt: 1 })
  const ticker = await ccxt.fetchTicker('BTC/USDT:USDT')
  const last = ticker.last
  if (last === undefined || !Number.isFinite(last) || last <= 0) {
    throw new Error('capture private-ws: no usable last price for BTCUSDT')
  }
  await wsApi.submitNewOrder(WS_CATEGORY, {
    symbol: 'BTCUSDT',
    orderType: 'limit',
    side: 'buy',
    qty: String(ORDER_SIZE),
    price: String(Math.round(last * PRICE_FACTOR)),
    clientOid,
    marginMode: 'isolated',
  })
  await new Promise<void>((resolve) => setTimeout(resolve, windowMs / 2))
  await wsApi.cancelOrder(WS_CATEGORY, { clientOid })
  await new Promise<void>((resolve) => setTimeout(resolve, windowMs / 2))
  ws.closeAll(true)
  wsApi.getWSClient().closeAll(true)

  const maps = createScrubMaps()
  const scrubbed = frames.map((f) => scrub(f, maps))
  writeJsonlFixture(`${outDir}/frames.jsonl`, scrubbed)
  writeManifest({
    dir: outDir,
    set: 'private-ws',
    venue: 'bitget',
    network: 'testnet',
    capturedAtMs: Date.now(),
    source: `bitget WebsocketClientV3 'update' — UTA topics ${PRIVATE_TOPICS.join(',')}, driven by one far-from-market limit placed and cancelled inside the window`,
    count: scrubbed.length,
  })
}

// ── orders (demo trading, env-gated) ───────────────────────────────────────────

/**
 * Resting buy limit at 97 % of last. **Not** a hard-coded far-from-market price: Bitget
 * enforces a per-symbol price band (`buyLimitPriceRatio`, 5 % on BTCUSDT) and answers anything
 * outside it with `43028`/`25205`, so the anchor has to be live (task 0440 Phase 2).
 */
const PRICE_FACTOR = 0.97
const ORDER_SIZE = 0.001 // base units; ~60 USDT at 2026 prices, over the 5 USDT minOrderAmount

export async function captureOrders(outDir: string = `${FIXTURES_ROOT}/orders`): Promise<void> {
  const creds = requireDemoCreds()
  const clock = createRealClock()

  const { ccxt, wsApiPrivate: wsApi } = createBitgetClients(PLACEHOLDER_PROFILE, creds, { network: 'testnet' })

  const clientOid = makeClientOrderId({ intentId: `cap-${clock.now()}`, leg: 'entry', attempt: 1 })
  const symbol = 'BTCUSDT'

  const ticker = await ccxt.fetchTicker('BTC/USDT:USDT')
  const last = ticker.last
  if (last === undefined || !Number.isFinite(last) || last <= 0) {
    throw new Error(`capture orders: no usable last price for ${symbol}`)
  }
  // Tick-rounded to a whole unit: the venue rejects a price that is not a multiple of its tick
  // (0.1 on BTCUSDT) — the same trap `ws-orders.ts#toVenueNumber` exists for.
  const price = Math.round(last * PRICE_FACTOR)

  const submitRes = await wsApi.submitNewOrder(WS_CATEGORY, {
    symbol,
    orderType: 'limit',
    side: 'buy',
    qty: String(ORDER_SIZE),
    price: String(price),
    clientOid,
    // Every adapter submit states the margin mode per order (`11` §1), so the fixture must too.
    marginMode: 'isolated',
  })

  // Bitget reads an order by client id directly — `clientOid` alongside the symbol.
  const order = await ccxt.fetchOrder(clientOid, 'BTC/USDT:USDT', { clientOid })

  const cancelRes = await wsApi.cancelOrder(WS_CATEGORY, { clientOid })

  const maps = createScrubMaps() // shared across all three so the one clientOid scrubs consistently
  writeJsonFixture(`${outDir}/ws-submit.json`, scrub(submitRes, maps))
  writeJsonFixture(`${outDir}/ccxt-order.json`, scrub(order, maps))
  writeJsonFixture(`${outDir}/ws-cancel.json`, scrub(cancelRes, maps))

  writeManifest({
    dir: outDir,
    set: 'orders',
    venue: 'bitget',
    network: 'testnet',
    capturedAtMs: clock.now(),
    source:
      'WebsocketAPIClient submitNewOrder/cancelOrder + ccxt fetchOrder(clientOid) — one far-from-market limit, immediately cancelled',
    count: 3,
  })
}
