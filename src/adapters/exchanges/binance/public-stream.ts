/**
 * Binance public market-data WS stream (`10_exchange_adapters_and_market_data.md` §7).
 *
 * Two public feeds, normalized onto the core event bus:
 *  - **Predicted funding** — the single all-market mark-price array stream
 *    `!markPrice@arr@1s` carries `fundingRate` + `nextFundingTime` for every usdm perp
 *    in one subscription. We publish `FundingPredicted` only for symbols in the
 *    subscribed universe that resolve in the instrument registry. One subscription for
 *    hundreds of perps beats hundreds of per-symbol streams (bandwidth budget, `10` §7).
 *  - **Last price** — per-symbol `<venueSymbol>@aggTrade`, dynamically sub/unsubscribed
 *    to the shortlist, published as `MarketTick`.
 *
 * Pipeline per `10` §7: raw formatted message → lib formatted type-guard → pure map →
 * `bus.publish`. Handlers never throw into the socket lib. A drop degrades to a REST
 * fallback poll and re-primes on reconnect via the shared {@link ReconnectController}.
 */

import {
  isWsAggTradeFormatted,
  isWsFormattedMarkPriceUpdateArray,
  WS_KEY_MAP,
  type WsFormattedMessage,
  type WsKey,
  type WsMessageAggTradeFormatted,
  type WsMessageMarkPriceEventFormatted,
} from 'binance'
import type { FundingPredicted, MarketTick } from '../../../core/events/types.js'
import type { EventBus } from '../../../core/ports/bus.js'
import type { Clock } from '../../../core/ports/clock.js'
import type { PublicStream, Rate } from '../../../core/ports/exchange-adapter.js'
import type { ReconnectController } from '../../shared/reconnect.js'
import { createReconnectController } from '../../shared/reconnect.js'

/** All-market mark-price array, 1 s cadence — one subscription, all usdm perps (`10` §7). */
const MARK_PRICE_ARR_TOPIC = '!markPrice@arr@1s'
/** Public market-data key; the lib auto-routes usdm market topics onto it. */
const MARKET_WS_KEY: WsKey = WS_KEY_MAP.usdmMarket
/** REST fallback poll cadence while degraded — well inside the 60 s freshness gate (`00_globals.md` §7). */
const FALLBACK_POLL_MS = 15_000

/** A last-price reading from the REST ticker fallback. */
export interface TickerReading {
  readonly price: number
  readonly ts: number
}

/**
 * Map an all-market mark-price entry to `FundingPredicted`. Returns `null` when the
 * venue reports no funding (`fundingRate === ''`) or the symbol does not resolve —
 * `resolveCanonical` folds `1000PEPE` → `PEPE` and gates on the subscribed universe.
 * `rate = fundingRate·100` (decimal → signed percent, `adapter.ts` convention).
 */
export function markPriceToFundingPredicted(
  msg: WsMessageMarkPriceEventFormatted,
  resolveCanonical: (venueSymbol: string) => string | undefined,
): FundingPredicted | null {
  if (msg.fundingRate === '') return null
  const symbol = resolveCanonical(msg.symbol)
  if (symbol === undefined) return null
  return { type: 'FundingPredicted', symbol, rate: msg.fundingRate * 100, ts: msg.eventTime }
}

/** Map an aggregate-trade message to `MarketTick`; `null` when the symbol does not resolve. */
export function aggTradeToMarketTick(
  msg: WsMessageAggTradeFormatted,
  resolveCanonical: (venueSymbol: string) => string | undefined,
): MarketTick | null {
  const symbol = resolveCanonical(msg.symbol)
  if (symbol === undefined) return null
  return { type: 'MarketTick', symbol, price: msg.price, ts: msg.eventTime }
}

/** The slice of the native `WebsocketClient` the public stream uses — the rest is 0220/0230. */
export interface BinanceWsClient {
  subscribe(topics: string | string[], wsKey: WsKey): Promise<unknown>
  unsubscribe(topics: string | string[], wsKey: WsKey): Promise<unknown[]>
  on(event: string, listener: (arg: unknown) => void): unknown
  closeAll(force?: boolean): void
}

export interface BinancePublicStreamDeps {
  readonly ws: BinanceWsClient
  readonly bus: EventBus
  readonly clock: Clock
  /** Venue id → canonical name off the live registry (`BTCUSDT` → `BTC`), or `undefined` if unknown. */
  resolveCanonical(venueSymbol: string): string | undefined
  /** Canonical name → exact venue string, for building per-symbol tick topics. */
  resolveVenue(symbol: string): string
  /**
   * Bulk predicted-funding read (adapter's all-symbol `premiumIndex`, SUGGESTIONS L21)
   * — one call replaces the per-symbol funding fan-out in the fallback poll/reprime.
   * Keyed by venue symbol; gated to the subscribed universe via `resolveFunding` before publish.
   */
  restFundingAll(): Promise<ReadonlyMap<string, Rate>>
  /** REST last-price read — the tick fallback/reprime source. */
  restTicker(symbol: string): Promise<TickerReading>
}

/** The `aggTrade` topic for a venue symbol — lowercase, matching the lib's own convention. */
function aggTradeTopic(venueSymbol: string): string {
  return `${venueSymbol.toLowerCase()}@aggTrade`
}

export function createBinancePublicStream(deps: BinancePublicStreamDeps): PublicStream {
  const { ws, bus, clock, resolveCanonical, resolveVenue, restFundingAll, restTicker } = deps

  // Subscribed sets (canonical). Funding gates the array stream; ticks track the shortlist.
  const fundingUniverse = new Set<string>()
  const tickSymbols = new Set<string>()

  /** Resolve + gate to the funding universe (the array stream carries every perp). */
  function resolveFunding(venueSymbol: string): string | undefined {
    const symbol = resolveCanonical(venueSymbol)
    return symbol !== undefined && fundingUniverse.has(symbol) ? symbol : undefined
  }

  /** Resolve + gate to the tick shortlist. */
  function resolveTick(venueSymbol: string): string | undefined {
    const symbol = resolveCanonical(venueSymbol)
    return symbol !== undefined && tickSymbols.has(symbol) ? symbol : undefined
  }

  /** Dispatch a formatted message → pure map → publish. Never throws into the socket lib. */
  function onFormattedMessage(msg: WsFormattedMessage): void {
    try {
      if (isWsFormattedMarkPriceUpdateArray(msg)) {
        for (const entry of msg) {
          const event = markPriceToFundingPredicted(entry, resolveFunding)
          if (event !== null) bus.publish(event)
        }
        return
      }
      if (isWsAggTradeFormatted(msg)) {
        const event = aggTradeToMarketTick(msg, resolveTick)
        if (event !== null) bus.publish(event)
      }
    } catch {
      // A bad message must never propagate into the socket lib's emit loop.
    }
  }

  /** One REST snapshot pass over the subscribed sets — reused by the fallback poll and reprime. */
  async function pollOnce(): Promise<void> {
    const funding = await restFundingAll()
    for (const [venueSymbol, rate] of funding) {
      const symbol = resolveFunding(venueSymbol)
      if (symbol === undefined) continue
      bus.publish({ type: 'FundingPredicted', symbol, rate: rate.rate, ts: rate.ts })
    }
    for (const symbol of tickSymbols) {
      const tick = await restTicker(symbol)
      bus.publish({ type: 'MarketTick', symbol, price: tick.price, ts: tick.ts })
    }
  }

  // Fallback poll: self-rescheduling while degraded; `onEnterDegraded` returns its stopper.
  const reconnect: ReconnectController = createReconnectController({
    clock,
    onEnterDegraded(): () => void {
      let cancelled = false
      const tick = (): void => {
        if (cancelled) return
        void pollOnce().finally(() => {
          if (!cancelled) clock.scheduleTimer(clock.now() + FALLBACK_POLL_MS, tick)
        })
      }
      tick()
      return () => {
        cancelled = true
      }
    },
    onReprime: pollOnce,
  })

  ws.on('formattedMessage', (arg) => onFormattedMessage(arg as WsFormattedMessage))
  ws.on('reconnecting', () => reconnect.markDisconnected())
  ws.on('reconnected', () => reconnect.markReconnected())

  return {
    async subscribe(symbols: readonly string[]): Promise<void> {
      fundingUniverse.clear()
      for (const symbol of symbols) fundingUniverse.add(symbol)
      await ws.subscribe(MARK_PRICE_ARR_TOPIC, MARKET_WS_KEY)
    },
    async subscribeTicks(symbols: readonly string[]): Promise<void> {
      const topics = symbols.map((symbol) => {
        tickSymbols.add(symbol)
        return aggTradeTopic(resolveVenue(symbol))
      })
      if (topics.length > 0) await ws.subscribe(topics, MARKET_WS_KEY)
    },
    async unsubscribeTicks(symbols: readonly string[]): Promise<void> {
      const topics = symbols.map((symbol) => {
        const topic = aggTradeTopic(resolveVenue(symbol))
        tickSymbols.delete(symbol)
        return topic
      })
      if (topics.length > 0) await ws.unsubscribe(topics, MARKET_WS_KEY)
    },
    close(): Promise<void> {
      ws.closeAll()
      return Promise.resolve()
    },
  }
}
