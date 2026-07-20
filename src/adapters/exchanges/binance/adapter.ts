/**
 * Binance {@link ExchangeAdapter} — market metadata only (task 0190). `init()` loads
 * markets via ccxt, filters to active linear USDT perps, builds a validated
 * `Instrument` registry (fail-loud on any anomaly), reloads it hourly, and serves the
 * synchronous `markets()`/`normalize()` reads plus funding REST.
 *
 * Everything trade-side — orders, positions, balances, account setup, WS streams — is
 * a `NotImplemented` stub filled by 0200–0240. The taxonomy + rate limiter are 0200;
 * this file builds **no** error infra (KISS). Mirrors the sim's shape so the same core
 * trades against either venue behind the one port.
 */

import type { EventBus } from '../../../core/ports/bus.js'
import type { Clock, TimerHandle } from '../../../core/ports/clock.js'
import type {
  Balance,
  ExchangeAdapter,
  FundingEvent,
  Instrument,
  MarginMode,
  Market,
  Order,
  OrderAck,
  OrderRequest,
  Position,
  PositionMode,
  PublicStream,
  Rate,
  TimeRange,
} from '../../../core/ports/exchange-adapter.js'
import type { RateLimiter } from '../../shared/rate-limiter.js'
import { mapBinanceError } from './error-map.js'
import type { BinanceMarketClient } from './factory.js'
import { buildInstrumentRegistry } from './instrument.js'
import { type BinanceWsClient, createBinancePublicStream, type TickerReading } from './public-stream.js'

const HOUR_MS = 3_600_000

/**
 * General-lane weights (`10` §6). `loadMarkets` pulls the full exchangeInfo payload so
 * it is heavier; the funding reads are single-symbol REST — weight 1. Placeholders
 * correctable when ccxt-reported per-endpoint weights are wired.
 */
const WEIGHT_LOAD_MARKETS = 20
const WEIGHT_FUNDING = 1
/** Single-symbol ticker read — the tick REST fallback poll (weight 1, general lane). */
const WEIGHT_TICKER = 1

/** Everything the adapter needs, all injectable so unit tests run offline (`10` §2). */
export interface BinanceAdapterDeps {
  /** ccxt-backed market/funding client (`./factory.ts`); a fake in tests. */
  readonly client: BinanceMarketClient
  /** Time + timers — the only clock the reload loop reads (`08` §5). */
  readonly clock: Clock
  /** Canonical names to exclude from the universe (`config.symbols.deny`, `10` §3). */
  readonly deny?: readonly string[]
  /**
   * Weighted rate limiter (task 0200). When present, the three REST reads draw the
   * **general** lane and their throws map through {@link mapBinanceError}; when absent
   * the reads pass through raw (keeps 0190's offline unit tests unchanged). The order
   * lane is wired into `placeOrder`/`cancelOrder` at 0230.
   */
  readonly limiter?: RateLimiter
  /**
   * Native public market-data WS client (`factory.ts` `wsPublic`). When present with
   * {@link bus}, the public stream (0210) is fully wired; when absent, `streams.public.*`
   * throws a clear "requires ws+bus" error so 0190/0200 offline tests construct unaffected.
   */
  readonly ws?: BinanceWsClient
  /** Core event bus the public stream publishes onto (`08` §4). Paired with {@link ws}. */
  readonly bus?: EventBus
}

/** ccxt reports funding as a fraction (`0.0001`); the engine speaks signed percent (`0.01`). */
function toSignedPercent(fundingRate: number | undefined): number {
  return (fundingRate ?? 0) * 100
}

/** Throw the uniform not-yet-built marker for a trade-side method (filled by 02xx). */
function notImplemented(method: string, task: string): never {
  throw new Error(`NotImplemented: BinanceAdapter.${method} — task ${task}`)
}

/** Placeholder public stream when `ws`/`bus` are not injected — every method fails loud. */
function unwiredPublicStream(): PublicStream {
  const fail = (): never => {
    throw new Error('BinanceAdapter: public stream requires ws+bus deps')
  }
  return {
    subscribe: fail,
    subscribeTicks: fail,
    unsubscribeTicks: fail,
    close: fail,
  }
}

export function createBinanceAdapter(deps: BinanceAdapterDeps): ExchangeAdapter {
  const { client, clock, limiter, ws, bus } = deps
  const deny = deps.deny ?? []

  /**
   * Run a general-lane REST read under the limiter, mapping any throw to a typed
   * {@link mapBinanceError} error. No limiter → passthrough (raw call, raw throw), so
   * the 0190 offline tests are unaffected.
   */
  async function callGeneral<T>(weight: number, fn: () => Promise<T>): Promise<T> {
    if (!limiter) return fn()
    await limiter.acquire(weight, 'general')
    try {
      return await fn()
    } catch (err) {
      throw mapBinanceError(err)
    }
  }

  // Swapped atomically on every (re)load — readers never see a half-built registry.
  let instruments = new Map<string, Instrument>()
  // Reverse index (venue id → canonical) for the public stream's per-message resolve —
  // O(1) instead of scanning `instruments` on every 1 s all-market mark-price array.
  let venueToNormalized = new Map<string, string>()
  let reloadHandle: TimerHandle | undefined

  /** Load + validate markets into a fresh registry, then swap the reference in. */
  async function reloadRegistry(): Promise<void> {
    const markets = await callGeneral(WEIGHT_LOAD_MARKETS, () => client.loadMarkets())
    const next = buildInstrumentRegistry(Object.values(markets), deny)
    const reverse = new Map<string, string>()
    for (const inst of next.values()) reverse.set(inst.venueSymbol, inst.normalized)
    instruments = next
    venueToNormalized = reverse
  }

  /** Self-perpetuating hourly reload (mirrors `scheduler.ts:scheduleScan`). */
  function armReload(): void {
    reloadHandle = clock.scheduleTimer(clock.now() + HOUR_MS, () => {
      // Fire-and-forget: a transient reload failure keeps the last-good registry and
      // the next tick retries. Re-arm first so one rejected load never stops the loop.
      armReload()
      void reloadRegistry()
    })
  }

  /** Look up a validated instrument; fail loud on an unknown symbol (sim parity, `10` §4). */
  function normalize(symbol: string): Instrument {
    const instrument = instruments.get(symbol)
    if (!instrument) throw new Error(`BinanceAdapter: unknown symbol '${symbol}'`)
    return instrument
  }

  /** Resolve a normalized symbol to its exact venue string for a REST call. */
  function venueSymbol(symbol: string): string {
    return normalize(symbol).venueSymbol
  }

  /** Predicted-funding REST read — the `predictedFunding` method and the stream fallback share it. */
  async function readPredictedFunding(symbol: string): Promise<Rate> {
    const fr = await callGeneral(WEIGHT_FUNDING, () => client.fetchFundingRate(venueSymbol(symbol)))
    return { symbol, rate: toSignedPercent(fr.fundingRate), ts: fr.timestamp ?? clock.now() }
  }

  /** Last-price REST read for the public stream's tick fallback/reprime. */
  async function readTicker(symbol: string): Promise<TickerReading> {
    const ticker = await callGeneral(WEIGHT_TICKER, () => client.fetchTicker(venueSymbol(symbol)))
    const price = ticker.last ?? ticker.close
    if (price === undefined) throw new Error(`BinanceAdapter: ticker for '${symbol}' carries no last/close price`)
    return { price, ts: ticker.timestamp ?? clock.now() }
  }

  /**
   * The public stream, wired only when both `ws` + `bus` are injected. Absent either,
   * every method throws a clear fail-loud error (the 0190/0200 offline tests never touch
   * streams, so their construction is unaffected).
   */
  const publicStream: PublicStream =
    ws && bus
      ? createBinancePublicStream({
          ws,
          bus,
          clock,
          resolveCanonical: (venue) => venueToNormalized.get(venue),
          resolveVenue: venueSymbol,
          restFunding: readPredictedFunding,
          restTicker: readTicker,
        })
      : unwiredPublicStream()

  return {
    // ── lifecycle ─────────────────────────────────────────────────────────────
    async init(): Promise<void> {
      await reloadRegistry() // fail-loud: a bad instrument aborts startup (`10` §3)
      armReload()
    },
    async close(): Promise<void> {
      reloadHandle?.cancel()
      reloadHandle = undefined
      if (ws && bus) await publicStream.close() // only the wired stream; the placeholder throws
    },

    // ── account setup (trade-side — 0240) ─────────────────────────────────────
    setLeverage(_symbol: string, _leverage: number): Promise<void> {
      return notImplemented('setLeverage', '0240')
    },
    setMarginMode(_symbol: string, _mode: MarginMode): Promise<void> {
      return notImplemented('setMarginMode', '0240')
    },
    setPositionMode(_mode: PositionMode): Promise<void> {
      return notImplemented('setPositionMode', '0240')
    },

    // ── market metadata (synchronous reads off the cached registry) ───────────
    markets(): Market[] {
      return [...instruments.values()].map((i) => ({
        normalized: i.normalized,
        venueSymbol: i.venueSymbol,
        status: 'trading',
      }))
    },
    normalize,

    // ── orders (native WS-first — 0230) ───────────────────────────────────────
    placeOrder(_req: OrderRequest): Promise<OrderAck> {
      return notImplemented('placeOrder', '0230')
    },
    cancelOrder(_clientOrderId: string): Promise<void> {
      return notImplemented('cancelOrder', '0230')
    },
    getOrder(_clientOrderId: string): Promise<Order> {
      return notImplemented('getOrder', '0230')
    },
    getPositions(): Promise<Position[]> {
      return notImplemented('getPositions', '0240')
    },
    getBalance(): Promise<Balance> {
      return notImplemented('getBalance', '0240')
    },

    // ── funding (ccxt REST) ───────────────────────────────────────────────────
    predictedFunding(symbol: string): Promise<Rate> {
      return readPredictedFunding(symbol)
    },
    async fundingHistory(symbol: string, range: TimeRange): Promise<FundingEvent[]> {
      const rows = await callGeneral(WEIGHT_FUNDING, () =>
        client.fetchFundingRateHistory(venueSymbol(symbol), range.fromTs),
      )
      return rows
        .filter((r) => r.timestamp !== undefined && r.timestamp >= range.fromTs && r.timestamp <= range.toTs)
        .map((r) => ({ symbol, rate: toSignedPercent(r.fundingRate), settleTs: r.timestamp as number }))
    },

    // ── streams (native WS — 0210 public / 0220 private) ──────────────────────
    streams: {
      public: publicStream,
      private: {
        subscribe(): Promise<void> {
          return notImplemented('streams.private.subscribe', '0220')
        },
        close(): Promise<void> {
          return notImplemented('streams.private.close', '0220')
        },
      },
    },
  } satisfies ExchangeAdapter
}
