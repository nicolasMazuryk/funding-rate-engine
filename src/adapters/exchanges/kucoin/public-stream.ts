/**
 * KuCoin Futures public market-data WS stream (`10_exchange_adapters_and_market_data.md` §7) —
 * same pipeline as the four siblings (raw frame → type guard → pure map → `bus.publish`), same
 * shared reconnect FSM, different venue shape.
 *
 * The venue quirks that shape this file, all read off the captured `public-ws` fixtures
 * (`test/fixtures/kucoin/public-ws/frames.jsonl`, both topics mixed into the one file) rather
 * than from recall:
 *  - **Two channels, OKX's shape, not Bybit's.** `/contract/instrument:<SYM>` carries funding
 *    (→ `FundingPredicted`) and `/contractMarket/ticker:<SYM>` carries the last traded price
 *    (→ `MarketTick`). Nothing is shared, so no reference count: each set owns its own topic and
 *    `unsubscribeTicks` can always drop the ticker subscription.
 *  - **One topic, two subjects.** `/contract/instrument` multiplexes `funding.rate`
 *    (`{fundingRate, granularity, period, timestamp}`) *and* `mark.index.price`
 *    (`{markPrice, indexPrice, …}`). Only the first is mapped: mark/index are **not** the last
 *    price, and feeding a mark price into `MarketTick` would silently mis-price every entry and
 *    exit. The subject is part of the type guard, so `mark.index.price` frames fall through.
 *  - **The ticker timestamp is in NANOSECONDS.** `data.ts` is e.g. `1785092660747000000`, not
 *    epoch ms — the one real trap on this venue. Used raw it lands ~56 000 years in the future
 *    and every freshness gate (`00_globals.md` §7) reads permanently fresh, so it is divided by
 *    1e6. The funding frame's `timestamp` is ordinary epoch ms; the two do not agree.
 *  - **The symbol is on the topic, not always on the row.** The ticker row carries
 *    `data.symbol`, but the instrument frames carry the instrument *only* in the topic suffix
 *    (`/contract/instrument:XBTUSDTM`), so it is parsed off there. A frame whose symbol does not
 *    resolve is dropped — never guessed from the subscribed set.
 *  - **No bulk funding read.** `kucoinfutures.has.fetchFundingRates === false` (see the note on
 *    `KucoinMarketClient` in `./factory.ts`), so the degraded-mode fallback poll is a per-symbol
 *    fan-out over the funding universe via `restFunding(symbol)` — one request per symbol, where
 *    all four siblings spend a single `restFundingAll()`. This is the one place KuCoin costs more
 *    requests than its siblings; the 15 s cadence and the limiter budget absorb it.
 *
 * As on every sibling, a blank or absent field maps to `null` rather than publishing a zero:
 * `Number('')` is `0`, which would poison the freshness gate and the sizing math alike.
 */

import type { FundingPredicted, MarketTick } from '../../../core/events/types.js'
import type { EventBus } from '../../../core/ports/bus.js'
import type { Clock } from '../../../core/ports/clock.js'
import type { PublicStream, Rate } from '../../../core/ports/exchange-adapter.js'
import type { ReconnectController } from '../../shared/reconnect.js'
import { createReconnectController } from '../../shared/reconnect.js'

/** Topic prefix carrying `funding.rate` (and `mark.index.price`, ignored here); `:<SYM>` appended. */
const INSTRUMENT_TOPIC = '/contract/instrument' as const

/** Topic prefix carrying the last traded price; `:<SYM>` appended. */
const TICKER_TOPIC = '/contractMarket/ticker' as const

/** The `/contract/instrument` subject this stream maps — the other one is `mark.index.price`. */
const FUNDING_SUBJECT = 'funding.rate' as const

/** The `/contractMarket/ticker` subject. */
const TICKER_SUBJECT = 'ticker' as const

/** Ticker `ts` is nanoseconds since epoch; divide to reach the repo-wide epoch-ms convention. */
const NANOS_PER_MS = 1e6

/** REST fallback poll cadence while degraded — well inside the 60 s freshness gate (`00_globals.md` §7). */
const FALLBACK_POLL_MS = 15_000

/** A last-price reading from the REST ticker fallback. */
export interface TickerReading {
  readonly price: number
  readonly ts: number
}

/** The `funding.rate` payload of a `/contract/instrument` frame (numbers, not strings). */
export interface KucoinFundingRateData {
  /** Funding rate as a decimal fraction (`-0.000007` = −0.0007 %); absent when the venue has no value. */
  readonly fundingRate?: number
  readonly granularity?: number
  readonly period?: number
  /** Push time, **epoch ms** — unlike the ticker frame's nanosecond `ts`. */
  readonly timestamp?: number
}

/** The `ticker` payload of a `/contractMarket/ticker` frame (prices as strings, times as numbers). */
export interface KucoinTickerData {
  readonly symbol?: string
  /** Last traded price; blank before the first trade. Not the mark or index price. */
  readonly price?: string
  readonly bestBidPrice?: string
  readonly bestAskPrice?: string
  /** Push time in **nanoseconds** since epoch — see {@link NANOS_PER_MS}. */
  readonly ts?: number
}

/** A public push frame as it arrives: `{topic, subject, data, type: 'message'}` — `data` is one object, not an array. */
export interface KucoinPublicFrame<T> {
  readonly topic?: string
  readonly subject?: string
  readonly type?: string
  readonly data?: T
}

/** Parse a KuCoin numeric field; `undefined` for absent/empty/unparsable (a blank is not 0). */
function num(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** The full topic string for one venue symbol: `<prefix>:<SYM>`. */
function topicFor(prefix: string, venueSymbol: string): string {
  return `${prefix}:${venueSymbol}`
}

/**
 * The venue symbol a frame is for, off the topic suffix (`/contract/instrument:XBTUSDTM` →
 * `XBTUSDTM`). The topic is the only place the instrument appears on the funding frames, so it
 * is the single source for both channels; `undefined` when the suffix is missing or empty.
 */
export function frameSymbol(frame: KucoinPublicFrame<unknown>): string | undefined {
  const topic = frame.topic
  if (typeof topic !== 'string') return undefined
  const suffix = topic.slice(topic.indexOf(':') + 1)
  return topic.includes(':') && suffix.length > 0 ? suffix : undefined
}

/** True when the frame is the named topic **and** the named subject, carrying a data object. */
export function isSubjectFrame<T>(msg: unknown, topicPrefix: string, subject: string): msg is KucoinPublicFrame<T> {
  if (typeof msg !== 'object' || msg === null) return false
  const frame = msg as { topic?: unknown; subject?: unknown; data?: unknown }
  if (typeof frame.topic !== 'string' || !frame.topic.startsWith(`${topicPrefix}:`)) return false
  if (frame.subject !== subject) return false
  return typeof frame.data === 'object' && frame.data !== null
}

/**
 * Map one `funding.rate` frame to `FundingPredicted`. Returns `null` when the frame carries no
 * usable rate or the symbol does not resolve — `resolveCanonical` folds the venue symbol
 * (`XBTUSDTM` → `BTC`) and gates on the subscribed universe. `rate = fundingRate·100` (decimal
 * fraction → signed percent, the `adapter.ts` convention).
 */
export function fundingFrameToFundingPredicted(
  frame: KucoinPublicFrame<KucoinFundingRateData>,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  now: () => number,
): FundingPredicted | null {
  const venue = frameSymbol(frame)
  if (venue === undefined) return null
  const rate = num(frame.data?.fundingRate)
  if (rate === undefined) return null
  const symbol = resolveCanonical(venue)
  if (symbol === undefined) return null
  return { type: 'FundingPredicted', symbol, rate: rate * 100, ts: num(frame.data?.timestamp) ?? now() }
}

/**
 * Map one `ticker` frame to `MarketTick`; `null` on a blank `price` or an unresolved symbol.
 * `data.ts` is **nanoseconds** — it is scaled to epoch ms here, the only place that conversion
 * happens.
 */
export function tickerFrameToMarketTick(
  frame: KucoinPublicFrame<KucoinTickerData>,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  now: () => number,
): MarketTick | null {
  const venue = frameSymbol(frame)
  if (venue === undefined) return null
  const price = num(frame.data?.price)
  if (price === undefined) return null
  const symbol = resolveCanonical(venue)
  if (symbol === undefined) return null
  const nanos = num(frame.data?.ts)
  return { type: 'MarketTick', symbol, price, ts: nanos === undefined ? now() : Math.floor(nanos / NANOS_PER_MS) }
}

/**
 * The slice of the native `WebsocketClient` the public stream uses. KuCoin's topics are plain
 * venue-shaped strings (no `arg`/request object as on OKX and Bitget), and both `subscribe` and
 * `unsubscribe` are **synchronous** — they return `void`, not a promise, because the SDK queues
 * the request against the bullet-token connection it owns.
 */
export interface KucoinWsClient {
  subscribe(topics: string[] | string, wsKey: string): void
  unsubscribe(topics: string[] | string, wsKey: string): void
  on(event: string, listener: (arg: unknown) => void): unknown
  closeAll(force?: boolean): void
}

export interface KucoinPublicStreamDeps {
  readonly ws: KucoinWsClient
  readonly bus: EventBus
  readonly clock: Clock
  /** The lib's connection key for the public futures socket (`WS_KEY_MAP.futuresPublicV1`). */
  readonly wsKey: string
  /** Venue symbol → canonical name off the live registry (`XBTUSDTM` → `BTC`), else `undefined`. */
  resolveCanonical(venueSymbol: string): string | undefined
  /** Canonical name → exact venue symbol, for building per-symbol topics. */
  resolveVenue(symbol: string): string
  /**
   * Predicted-funding read for **one** symbol (canonical), already in signed percent. KuCoin
   * publishes no bulk funding endpoint, so the fallback poll/reprime fans this out over the
   * funding universe instead of spending one `restFundingAll()` like the siblings.
   */
  restFunding(symbol: string): Promise<Rate>
  /** REST last-price read — the tick fallback/reprime source. */
  restTicker(symbol: string): Promise<TickerReading>
}

export function createKucoinPublicStream(deps: KucoinPublicStreamDeps): PublicStream {
  const { ws, bus, clock, wsKey, resolveCanonical, resolveVenue, restFunding, restTicker } = deps

  // Subscribed sets (canonical). Each gates — and owns — its own topic.
  const fundingUniverse = new Set<string>()
  const tickSymbols = new Set<string>()

  /** Resolve + gate to the funding universe. */
  function resolveFunding(venueSymbol: string): string | undefined {
    const symbol = resolveCanonical(venueSymbol)
    return symbol !== undefined && fundingUniverse.has(symbol) ? symbol : undefined
  }

  /** Resolve + gate to the tick shortlist. */
  function resolveTick(venueSymbol: string): string | undefined {
    const symbol = resolveCanonical(venueSymbol)
    return symbol !== undefined && tickSymbols.has(symbol) ? symbol : undefined
  }

  function subscribeTopics(topics: string[]): void {
    if (topics.length === 0) return
    ws.subscribe(topics, wsKey)
  }

  function unsubscribeTopics(topics: string[]): void {
    if (topics.length === 0) return
    ws.unsubscribe(topics, wsKey)
  }

  /** Dispatch one frame → pure maps → publish. Never throws into the socket lib. */
  function onUpdate(msg: unknown): void {
    try {
      // `mark.index.price` shares the instrument topic and is deliberately unhandled: it is not
      // the last price, so it feeds neither event.
      if (isSubjectFrame<KucoinFundingRateData>(msg, INSTRUMENT_TOPIC, FUNDING_SUBJECT)) {
        const funding = fundingFrameToFundingPredicted(msg, resolveFunding, clock.now)
        if (funding !== null) bus.publish(funding)
        return
      }
      if (isSubjectFrame<KucoinTickerData>(msg, TICKER_TOPIC, TICKER_SUBJECT)) {
        const tick = tickerFrameToMarketTick(msg, resolveTick, clock.now)
        if (tick !== null) bus.publish(tick)
      }
    } catch {
      // A bad message must never propagate into the socket lib's emit loop.
    }
  }

  /**
   * One REST snapshot pass over the subscribed sets — reused by the fallback poll and reprime.
   * The funding half is a per-symbol fan-out (no bulk read on this venue, see the file header).
   */
  async function pollOnce(): Promise<void> {
    for (const symbol of fundingUniverse) {
      const rate = await restFunding(symbol)
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

  ws.on('update', onUpdate)
  ws.on('reconnect', () => reconnect.markDisconnected())
  ws.on('reconnected', () => reconnect.markReconnected())

  return {
    subscribe(symbols: readonly string[]): Promise<void> {
      // The universe is re-declared wholesale on every registry refresh and each symbol costs its
      // own subscription, so diff it. No refcount against the tick shortlist here: the instrument
      // topic is this set's alone (the ticker topic is the shortlist's alone).
      const next = new Set(symbols)
      const added: string[] = []
      const removed: string[] = []
      for (const symbol of next) {
        if (!fundingUniverse.has(symbol)) added.push(topicFor(INSTRUMENT_TOPIC, resolveVenue(symbol)))
      }
      for (const symbol of fundingUniverse) {
        if (!next.has(symbol)) removed.push(topicFor(INSTRUMENT_TOPIC, resolveVenue(symbol)))
      }
      fundingUniverse.clear()
      for (const symbol of next) fundingUniverse.add(symbol)
      subscribeTopics(added)
      unsubscribeTopics(removed)
      return Promise.resolve()
    },
    subscribeTicks(symbols: readonly string[]): Promise<void> {
      const topics: string[] = []
      for (const symbol of symbols) {
        if (!tickSymbols.has(symbol)) topics.push(topicFor(TICKER_TOPIC, resolveVenue(symbol)))
        tickSymbols.add(symbol)
      }
      subscribeTopics(topics)
      return Promise.resolve()
    },
    unsubscribeTicks(symbols: readonly string[]): Promise<void> {
      const topics: string[] = []
      for (const symbol of symbols) {
        if (tickSymbols.delete(symbol)) topics.push(topicFor(TICKER_TOPIC, resolveVenue(symbol)))
      }
      unsubscribeTopics(topics)
      return Promise.resolve()
    },
    close(): Promise<void> {
      ws.closeAll()
      return Promise.resolve()
    },
  }
}
