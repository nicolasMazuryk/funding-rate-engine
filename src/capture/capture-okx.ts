/**
 * OKX capture drivers (task 0430, mirroring `./capture-bybit.ts`). Each set drives the
 * **real** ccxt/native clients (`src/adapters/exchanges/okx/factory.ts`) — never a fake —
 * collects raw payloads exactly as the adapter receives them (pre-scrub), scrubs in-memory,
 * and writes deterministic fixtures under `test/fixtures/okx/<set>/`. Fail-loud when required
 * creds are absent (mirrors the integration-gate convention: skip, don't silently do nothing).
 *
 * `markets`/`public-ws` are credential-free (public REST/WS). `private-ws`/`orders` require
 * demo-trading keys and never touch the account beyond one far-from-market limit order that
 * is immediately cancelled.
 *
 * OKX divergences from the Bybit driver:
 *  - the credential trio: OKX signs with key + secret + **passphrase**, and its "testnet" is
 *    demo trading — a flag on the same host (`demoTrading: true`), not a separate domain;
 *  - the funding interval is not a market-metadata field, so the `markets` set additionally
 *    records the raw `funding-rate` rows for the captured symbols: the interval is
 *    `nextFundingTime − fundingTime` and the unit tests derive it exactly as the adapter does;
 *  - the public funding + tick signals are **two** channels (`funding-rate` and `tickers`),
 *    where Bybit fuses both into one `tickers.<SYMBOL>` topic;
 *  - orders go out with `tdMode: 'isolated'` and `clOrdId` (not `orderLinkId`), and the reply
 *    nests its real status at `data[0].sCode`.
 */

import { okx } from 'ccxt'
import { WebsocketClient } from 'okx-api'
import { createRealClock } from '../adapters/clock/real-clock.js'
import { createOkxClients } from '../adapters/exchanges/okx/factory.js'
import type { ExchangeProfile } from '../config/exchange-schema.js'
import { makeClientOrderId } from '../core/order-id/client-order-id.js'
import { writeJsonFixture, writeJsonlFixture } from './fixture-writer.js'
import { writeManifest } from './manifest.js'
import { createScrubMaps, scrub } from './scrub.js'

const FIXTURES_ROOT = 'test/fixtures/okx'

/**
 * Fees/stagger/rate-limit fields are unused by capture (no order-cost math); the factory
 * signature requires a full {@link ExchangeProfile} regardless.
 */
const PLACEHOLDER_PROFILE: ExchangeProfile = {
  takerFeePct: 0.05,
  makerFeePct: 0.02,
  submissionStaggerMs: 100,
  rateLimitReservePct: 50,
  rateLimitWeightPerMinute: 1200,
  wsOrderAdapter: true,
  ws: { publicUrl: 'wss://ws.okx.com:8443/ws/v5/public', privateUrl: 'wss://ws.okx.com:8443/ws/v5/private' },
  deltas: {},
}

interface OkxCredentials {
  apiKey: string
  apiSecret: string
  apiPassphrase: string
}

function requireDemoCreds(): OkxCredentials {
  const apiKey = process.env.OKX_TESTNET_API_KEY
  const apiSecret = process.env.OKX_TESTNET_API_SECRET
  const apiPassphrase = process.env.OKX_TESTNET_PASSPHRASE
  if (!apiKey || !apiSecret || !apiPassphrase) {
    throw new Error(
      'capture: OKX_TESTNET_API_KEY / OKX_TESTNET_API_SECRET / OKX_TESTNET_PASSPHRASE required for this set (demo trading only)',
    )
  }
  return { apiKey, apiSecret, apiPassphrase }
}

// ── markets (public, no creds) ─────────────────────────────────────────────────

/**
 * Venue ids a healthy live listing genuinely emits, chosen to cover what OKX makes
 * load-bearing: a sub-unit `ctVal` (BTC = 0.01), a large `ctVal` (XRP = 100 — the fixture the
 * contract-size sizing chain runs on), the venue's 4 h funding cadence, and a base that
 * starts with a digit but carries no multiplier (`1INCH`, the normalization trap).
 */
const CAPTURABLE_MARKETS: readonly { readonly id: string; readonly symbol: string; readonly stem: string }[] = [
  { id: 'BTC-USDT-SWAP', symbol: 'BTC/USDT:USDT', stem: 'clean-perp-btc' },
  { id: 'XRP-USDT-SWAP', symbol: 'XRP/USDT:USDT', stem: 'ctval-100-xrp' },
  { id: 'LAYER-USDT-SWAP', symbol: 'LAYER/USDT:USDT', stem: 'funding-4h-layer' },
  { id: '1INCH-USDT-SWAP', symbol: '1INCH/USDT:USDT', stem: 'digit-base-1inch' },
]

/**
 * Hand-authored, irreducibly synthetic sibling fixtures — no healthy live listing emits these
 * shapes (spot/inverse/dated come from other instrument types; the anomalies are deliberately
 * malformed; the collision rows exercise a multiplier prefix OKX does not currently list).
 * Left as authored JSON, listed here so `captureMarkets` records them in the manifest.
 */
const SYNTHETIC_MARKETS: readonly string[] = [
  'spot-btc',
  'inverse-coinm',
  'dated-expiry',
  'delisted',
  'anomaly-missing-precision',
  'anomaly-zero-contractsize',
  'anomaly-unparsable-base',
  'anomaly-ctval-mismatch',
  'multiplier-cat',
  'plain-cat',
]

/**
 * Capture the market rows **and** the funding-rate rows for the same symbols: on OKX the
 * funding interval only exists as `nextFundingTime − fundingTime`, so a market fixture alone
 * cannot express a 4 h symbol. `funding-rates.json` keeps the raw rows keyed by `instId`.
 */
export async function captureMarkets(outDir: string = `${FIXTURES_ROOT}/markets`): Promise<void> {
  // No credentials at all, deliberately: the market + funding-rate reads are public, and an
  // unauthenticated client cannot leak account material into a committed fixture.
  const ccxt = new okx({ enableRateLimit: true, options: { defaultType: 'swap' } })
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

  const rates = await ccxt.fetchFundingRates(CAPTURABLE_MARKETS.map((m) => m.symbol))
  const fundingRows: Record<string, unknown> = {}
  for (const { id } of CAPTURABLE_MARKETS) {
    const row = Object.values(rates).find((r) => (r.info as { instId?: string } | undefined)?.instId === id)
    if (!row) throw new Error(`capture markets: no funding-rate row for '${id}'`)
    fundingRows[id] = scrub(row.info, maps, { normalizeVolatile: false })
  }
  writeJsonFixture(`${outDir}/funding-rates.json`, fundingRows)
  count++

  writeManifest({
    dir: outDir,
    set: 'markets',
    venue: 'okx',
    network: 'prod',
    capturedAtMs: Date.now(),
    source:
      'ccxt.okx#loadMarkets (public /api/v5/public/instruments) + #fetchFundingRates (public /api/v5/public/funding-rate)',
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

/** Venue instrument ids (not canonical names): OKX channel args are venue-shaped. */
const DEFAULT_PUBLIC_WS_SYMBOLS = ['BTC-USDT-SWAP']
const DEFAULT_PUBLIC_WS_COUNT = 20
const DEFAULT_PUBLIC_WS_WINDOW_MS = 20_000

/**
 * Subscribe the public `tickers` **and** `funding-rate` channels and collect raw `'update'`
 * frames until `count` or `windowMs`. Two channels, not one: OKX splits the last price from
 * the predicted funding rate, where Bybit fuses them.
 */
export async function capturePublicWs(opts: PublicWsCaptureOptions = {}): Promise<void> {
  const outDir = opts.outDir ?? `${FIXTURES_ROOT}/public-ws`
  const symbols = opts.symbols ?? DEFAULT_PUBLIC_WS_SYMBOLS
  const count = opts.count ?? DEFAULT_PUBLIC_WS_COUNT
  const windowMs = opts.windowMs ?? DEFAULT_PUBLIC_WS_WINDOW_MS

  const ws = new WebsocketClient({})
  const frames: unknown[] = []
  ws.on('update', (msg) => frames.push(msg))

  const args = symbols.flatMap((instId) => [
    { channel: 'tickers' as const, instId },
    { channel: 'funding-rate' as const, instId },
  ])
  await Promise.all(ws.subscribe(args))

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
    venue: 'okx',
    network: 'prod',
    capturedAtMs: Date.now(),
    source: `okx WebsocketClient 'update' — tickers + funding-rate for ${symbols.join(',')}`,
    count: scrubbed.length,
  })
}

// ── private-ws (demo trading, env-gated) ───────────────────────────────────────

export interface PrivateWsCaptureOptions {
  readonly windowMs?: number
  readonly outDir?: string
}

const DEFAULT_PRIVATE_WS_WINDOW_MS = 20_000

/** The three private channels the adapter subscribes (`11` §7) — one credentialed connection. */
const PRIVATE_CHANNELS = [
  { channel: 'account' as const },
  { channel: 'positions' as const, instType: 'ANY' as const },
  { channel: 'orders' as const, instType: 'ANY' as const },
]

/** Subscribe the private channels and collect whatever `'update'` frames arrive in the window. */
export async function capturePrivateWs(opts: PrivateWsCaptureOptions = {}): Promise<void> {
  const outDir = opts.outDir ?? `${FIXTURES_ROOT}/private-ws`
  const windowMs = opts.windowMs ?? DEFAULT_PRIVATE_WS_WINDOW_MS
  const creds = requireDemoCreds()

  const { wsPrivate: ws } = createOkxClients(PLACEHOLDER_PROFILE, creds, { network: 'testnet' })
  const frames: unknown[] = []
  ws.on('update', (msg) => frames.push(msg))

  await Promise.all(ws.subscribe(PRIVATE_CHANNELS, true))
  await new Promise<void>((resolve) => setTimeout(resolve, windowMs))
  ws.closeAll(true)

  const maps = createScrubMaps()
  const scrubbed = frames.map((f) => scrub(f, maps))
  writeJsonlFixture(`${outDir}/frames.jsonl`, scrubbed)
  writeManifest({
    dir: outDir,
    set: 'private-ws',
    venue: 'okx',
    network: 'testnet',
    capturedAtMs: Date.now(),
    source: `okx WebsocketClient 'update' — private channels ${PRIVATE_CHANNELS.map((c) => c.channel).join(',')}`,
    count: scrubbed.length,
  })
}

// ── orders (demo trading, env-gated) ───────────────────────────────────────────

const FAR_FROM_MARKET_PRICE = 20_000 // BTC limit far below market — rests, never fills
const ORDER_SIZE_CONTRACTS = 0.01 // OKX BTC-USDT-SWAP minSz, in contracts (ctVal 0.01 BTC)

export async function captureOrders(outDir: string = `${FIXTURES_ROOT}/orders`): Promise<void> {
  const creds = requireDemoCreds()
  const clock = createRealClock()

  const { ccxt, wsApiPrivate: wsApi } = createOkxClients(PLACEHOLDER_PROFILE, creds, { network: 'testnet' })

  const clientOrderId = makeClientOrderId({ intentId: `capture-${clock.now()}`, leg: 'entry', attempt: 1 })
  const instId = 'BTC-USDT-SWAP'

  const submitRes = await wsApi.submitNewOrder({
    instId,
    tdMode: 'isolated',
    side: 'buy',
    ordType: 'limit',
    sz: String(ORDER_SIZE_CONTRACTS),
    px: String(FAR_FROM_MARKET_PRICE),
    clOrdId: clientOrderId,
  })

  // OKX reads an order by client id directly — `clOrdId` alongside the instrument.
  const order = await ccxt.fetchOrder(clientOrderId, 'BTC/USDT:USDT', { clOrdId: clientOrderId })

  const cancelRes = await wsApi.cancelOrder({ instId, clOrdId: clientOrderId })

  const maps = createScrubMaps() // shared across all three so the one clientOrderId scrubs consistently
  writeJsonFixture(`${outDir}/ws-submit.json`, scrub(submitRes, maps))
  writeJsonFixture(`${outDir}/ccxt-order.json`, scrub(order, maps))
  writeJsonFixture(`${outDir}/ws-cancel.json`, scrub(cancelRes, maps))

  writeManifest({
    dir: outDir,
    set: 'orders',
    venue: 'okx',
    network: 'testnet',
    capturedAtMs: clock.now(),
    source:
      'WebsocketAPIClient submitNewOrder/cancelOrder + ccxt fetchOrder(clOrdId) — one far-from-market limit, immediately cancelled',
    count: 3,
  })
}
