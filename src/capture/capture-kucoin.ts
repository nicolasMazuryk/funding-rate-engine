/**
 * KuCoin Futures capture drivers (task 0460, mirroring `./capture-bitget.ts`). The two public
 * sets drive the **real** ccxt/native clients, collect raw payloads exactly as the adapter
 * receives them (pre-scrub), scrub in-memory, and write deterministic fixtures under
 * `test/fixtures/kucoin/<set>/`.
 *
 * The private sets are the divergence, and it is deliberate. KuCoin **decommissioned its futures
 * sandbox** (`ccxt.kucoinfutures` has no `urls.test`; `setSandboxMode(true)` silently sets
 * `urls.api = {}` — see `../adapters/exchanges/kucoin/factory.ts`). Every sibling driver records
 * `private-ws` / `orders` by placing one far-from-market limit order on a *demo* account and
 * cancelling it; on KuCoin the only account that exists is a live one, so the identical code
 * would place a **real order with real money**. That is exactly what this venue's read-only
 * posture exists to prevent, so both functions **throw** instead: fail-loud, pointing at the
 * hand-authored manifests, rather than a silent no-op that reads as "captured".
 *
 * The four-function `Driver` shape (`scripts/capture.ts`) is unchanged — a venue is data in the
 * `DRIVERS` map, not a branch in the CLI.
 */

import { kucoinfutures } from 'ccxt'
import { WebsocketClient, WS_KEY_MAP } from 'kucoin-api'
import { writeJsonFixture, writeJsonlFixture } from './fixture-writer.js'
import { writeManifest } from './manifest.js'
import { createScrubMaps, scrub } from './scrub.js'

const FIXTURES_ROOT = 'test/fixtures/kucoin'

// ── markets (public, no creds) ─────────────────────────────────────────────────

/**
 * Venue ids a healthy live listing genuinely emits, chosen to cover what KuCoin makes
 * load-bearing:
 *  - `XBTUSDTM` — three quirks in one row: the `XBT` spelling ccxt maps to `BTC`, the `M`
 *    suffix, and a **sub-unit** `multiplier` (0.001 BTC per contract);
 *  - `ETHUSDTM` / `DOGEUSDTM` — a second sub-unit multiplier (0.01) and a supra-unit one (100),
 *    so the contract-size chain is exercised in both directions;
 *  - `1INCHUSDTM` — `multiplier: 1` **and** the letter-follows normalization trap in one row;
 *  - `1000BONKUSDTM` / `10000CATUSDTM` — a name prefix stacked on a non-unit multiplier. The
 *    case that decides `instrument.ts`: the quoted price is per *prefixed* unit, so the prefix
 *    must not be folded into `contractSize` a second time;
 *  - `WIFUSDTM` (4 h) / `LRCUSDTM` (1 h) — the non-8 h `fundingRateGranularity` cadences;
 *  - `XBTUSDM` — a real coin-margined row (`multiplier: -1`) the `10` §3 filter must drop.
 */
const CAPTURABLE_MARKETS: readonly { readonly id: string; readonly stem: string }[] = [
  { id: 'XBTUSDTM', stem: 'clean-perp-btc' },
  { id: 'ETHUSDTM', stem: 'multiplier-sub-unit-eth' },
  { id: 'DOGEUSDTM', stem: 'multiplier-100-doge' },
  { id: '1INCHUSDTM', stem: 'digit-base-1inch' },
  { id: '1000BONKUSDTM', stem: 'prefix-1000-bonk' },
  { id: '10000CATUSDTM', stem: 'prefix-10000-cat' },
  { id: 'WIFUSDTM', stem: 'funding-4h-wif' },
  { id: 'LRCUSDTM', stem: 'funding-1h-lrc' },
  { id: 'XBTUSDM', stem: 'inverse-coinm-xbt' },
]

/**
 * Hand-authored, irreducibly synthetic sibling fixtures — no healthy live listing emits these
 * shapes (spot comes from another exchange class; the anomalies are deliberately malformed;
 * `plain-bonk` is the collision partner for `1000BONKUSDTM`, which the venue does not list).
 * Left as authored JSON, listed here so `captureMarkets` records them in the manifest.
 */
const SYNTHETIC_MARKETS: readonly string[] = [
  'spot-btc',
  'delisted',
  'anomaly-missing-precision',
  'anomaly-zero-contractsize',
  'anomaly-unparsable-base',
  'anomaly-multiplier-mismatch',
  'anomaly-funding-interval',
  'plain-bonk',
]

/**
 * Capture the market rows. One read is enough on this venue: `info.fundingRateGranularity`
 * carries the funding cadence in milliseconds, so — unlike OKX — no companion funding-rate read
 * is needed to express a non-8 h symbol.
 */
export async function captureMarkets(outDir: string = `${FIXTURES_ROOT}/markets`): Promise<void> {
  // No credentials at all, deliberately: the market read is public, and an unauthenticated
  // client cannot leak account material into a committed fixture.
  const ccxt = new kucoinfutures({ enableRateLimit: true, options: { defaultType: 'swap' } })
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
    venue: 'kucoin',
    network: 'prod',
    capturedAtMs: Date.now(),
    source: 'ccxt.kucoinfutures#loadMarkets (public GET /api/v1/contracts/active)',
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

/** Venue symbols (not canonical names): KuCoin topic args are venue-shaped. */
const DEFAULT_PUBLIC_WS_SYMBOLS = ['XBTUSDTM']
const DEFAULT_PUBLIC_WS_COUNT = 40
/**
 * 90 s, well above the siblings' 20 s. `/contract/instrument` pushes `mark.index.price` every
 * second but `funding.rate` only once per minute, and a frames file without a funding frame
 * cannot back the funding half of the stream mapper.
 */
const DEFAULT_PUBLIC_WS_WINDOW_MS = 90_000

/**
 * The two public topics the adapter subscribes (`./public-stream.ts`) — OKX's two-channel shape
 * rather than Bybit/Bitget's fused ticker:
 *  - `/contract/instrument:{symbol}` → funding (`subject: 'funding.rate'`) and mark/index price
 *    (`subject: 'mark.index.price'`);
 *  - `/contractMarket/ticker:{symbol}` → last traded price (`subject: 'ticker'`).
 */
const PUBLIC_TOPICS = ['/contract/instrument', '/contractMarket/ticker'] as const

/**
 * Subscribe both public topics and collect raw `'update'` frames until `count` or `windowMs`.
 * The two topics land in **one** `frames.jsonl`, so `ws-fixtures.ts` filters by topic — the
 * sibling venues' single-topic files need no such filter.
 */
export async function capturePublicWs(opts: PublicWsCaptureOptions = {}): Promise<void> {
  const outDir = opts.outDir ?? `${FIXTURES_ROOT}/public-ws`
  const symbols = opts.symbols ?? DEFAULT_PUBLIC_WS_SYMBOLS
  const count = opts.count ?? DEFAULT_PUBLIC_WS_COUNT
  const windowMs = opts.windowMs ?? DEFAULT_PUBLIC_WS_WINDOW_MS

  const ws = new WebsocketClient({})
  const frames: unknown[] = []
  ws.on('update', (msg) => frames.push(msg))

  ws.subscribe(
    symbols.flatMap((symbol) => PUBLIC_TOPICS.map((topic) => `${topic}:${symbol}`)),
    WS_KEY_MAP.futuresPublicV1,
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
    venue: 'kucoin',
    network: 'prod',
    capturedAtMs: Date.now(),
    source: `kucoin WebsocketClient 'update' — ${PUBLIC_TOPICS.join(' + ')} for ${symbols.join(',')}`,
    count: scrubbed.length,
  })
}

// ── private-ws / orders (no sandbox — hand-authored, never captured) ───────────

/**
 * The message both private drivers throw with. Spelled once so the two failures read
 * identically, and so the reason lives beside the code rather than only in a doc.
 */
function noSandbox(set: 'private-ws' | 'orders'): never {
  throw new Error(
    `capture ${set}: KuCoin has no futures sandbox, so capturing this set would place a REAL order on a LIVE account. ` +
      `The ${set} fixtures under ${FIXTURES_ROOT}/${set}/ are hand-authored from the SDK's typed frame shapes; ` +
      `edit them (and their manifest's 'synthetic' list) instead of re-capturing.`,
  )
}

export function capturePrivateWs(_opts: { windowMs?: number; outDir?: string } = {}): Promise<void> {
  return noSandbox('private-ws')
}

export function captureOrders(_outDir?: string): Promise<void> {
  return noSandbox('orders')
}
