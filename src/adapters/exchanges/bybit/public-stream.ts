/**
 * Bybit public market-data WS stream (`10_exchange_adapters_and_market_data.md` §7) — the
 * counterpart of `../binance/public-stream.ts`, same pipeline (raw frame → type guard →
 * pure map → `bus.publish`), same shared reconnect FSM, different venue shape.
 *
 * Venue quirks that drive the design:
 *  - **One topic, both signals.** `tickers.<SYMBOL>` on the `linear` category carries
 *    `fundingRate` + `nextFundingTime` (→ `FundingPredicted`) *and* `lastPrice`
 *    (→ `MarketTick`). So a single subscription per symbol serves both port methods, and
 *    the topic is reference-counted between the funding universe and the tick shortlist:
 *    `unsubscribeTicks` only drops the topic for a symbol outside the funding universe.
 *  - **No all-symbol funding stream.** Binance fans hundreds of perps out of one
 *    `!markPrice@arr@1s`; Bybit has no equivalent, so the funding universe costs N
 *    per-symbol subscriptions. The all-symbol REST fallback is still one call
 *    (ccxt `fetchFundingRates`).
 *  - **Frames are deltas.** After the initial `snapshot`, Bybit pushes only changed
 *    fields, so `lastPrice`/`fundingRate` are frequently absent — every map returns `null`
 *    for a missing field instead of publishing a zero (a zero price would poison the
 *    freshness gate and the sizing math).
 */

import type { CategoryV5, WSTickerV5 } from 'bybit-api'
import type { FundingPredicted, MarketTick } from '../../../core/events/types.js'
import type { EventBus } from '../../../core/ports/bus.js'
import type { Clock } from '../../../core/ports/clock.js'
import type { PublicStream, Rate } from '../../../core/ports/exchange-adapter.js'
import type { ReconnectController } from '../../shared/reconnect.js'
import { createReconnectController } from '../../shared/reconnect.js'

/** Linear USDT perpetuals — the only category this adapter subscribes (`10` §3). */
const CATEGORY: CategoryV5 = 'linear'
/** REST fallback poll cadence while degraded — well inside the 60 s freshness gate (`00_globals.md` §7). */
const FALLBACK_POLL_MS = 15_000

/** A last-price reading from the REST ticker fallback. */
export interface TickerReading {
  readonly price: number
  readonly ts: number
}

/**
 * A `tickers.<SYMBOL>` frame as it actually arrives: `type: 'snapshot'` carries the full
 * {@link WSTickerV5}, `type: 'delta'` only the changed fields (the lib types the payload as
 * complete, hence the `Partial`).
 */
export interface BybitTickerFrame {
  readonly topic: string
  readonly type?: string
  /** Event timestamp, epoch ms UTC. */
  readonly ts?: number
  readonly data?: Partial<WSTickerV5>
}

/** Parse a Bybit numeric string field; `undefined` for absent/empty/unparsable (delta frames). */
function num(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** True for a `tickers.…` frame — the only public topic this stream subscribes. */
export function isTickerFrame(msg: unknown): msg is BybitTickerFrame {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as { topic?: unknown }).topic === 'string' &&
    (msg as { topic: string }).topic.startsWith('tickers.')
  )
}

/**
 * Map a `tickers` frame to `FundingPredicted`. Returns `null` when the frame carries no
 * `fundingRate` (the common delta case) or the symbol does not resolve — `resolveCanonical`
 * folds `1000PEPE` → `PEPE` and gates on the subscribed universe.
 * `rate = fundingRate·100` (decimal → signed percent, `adapter.ts` convention).
 */
export function tickerToFundingPredicted(
  frame: BybitTickerFrame,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  now: () => number,
): FundingPredicted | null {
  const venue = frame.data?.symbol
  if (typeof venue !== 'string') return null
  const rate = num(frame.data?.fundingRate)
  if (rate === undefined) return null
  const symbol = resolveCanonical(venue)
  if (symbol === undefined) return null
  return { type: 'FundingPredicted', symbol, rate: rate * 100, ts: frame.ts ?? now() }
}

/**
 * Map a `tickers` frame to `MarketTick`; `null` when the frame carries no `lastPrice`
 * (delta) or the symbol does not resolve.
 */
export function tickerToMarketTick(
  frame: BybitTickerFrame,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  now: () => number,
): MarketTick | null {
  const venue = frame.data?.symbol
  if (typeof venue !== 'string') return null
  const price = num(frame.data?.lastPrice)
  if (price === undefined) return null
  const symbol = resolveCanonical(venue)
  if (symbol === undefined) return null
  return { type: 'MarketTick', symbol, price, ts: frame.ts ?? now() }
}

/** The slice of the native `WebsocketClient` the public stream uses. */
export interface BybitWsClient {
  /** Returns one promise per underlying connection (the lib fans out), hence the array. */
  subscribeV5(topics: string[] | string, category: CategoryV5, isPrivateTopic?: boolean): Promise<unknown>[]
  unsubscribeV5(topics: string[] | string, category: CategoryV5, isPrivateTopic?: boolean): Promise<unknown>[]
  on(event: string, listener: (arg: unknown) => void): unknown
  closeAll(force?: boolean): void
}

export interface BybitPublicStreamDeps {
  readonly ws: BybitWsClient
  readonly bus: EventBus
  readonly clock: Clock
  /** Venue id → canonical name off the live registry (`BTCUSDT` → `BTC`), or `undefined` if unknown. */
  resolveCanonical(venueSymbol: string): string | undefined
  /** Canonical name → exact venue string, for building per-symbol topics. */
  resolveVenue(symbol: string): string
  /**
   * Bulk predicted-funding read (adapter's all-symbol ccxt `fetchFundingRates`) — one call
   * replaces the per-symbol funding fan-out in the fallback poll/reprime. Keyed by venue
   * symbol; gated to the subscribed universe via `resolveFunding` before publish.
   */
  restFundingAll(): Promise<ReadonlyMap<string, Rate>>
  /** REST last-price read — the tick fallback/reprime source. */
  restTicker(symbol: string): Promise<TickerReading>
}

/** The `tickers` topic for a venue symbol (Bybit topics are case-sensitive, upper-case symbols). */
function tickerTopic(venueSymbol: string): string {
  return `tickers.${venueSymbol}`
}

export function createBybitPublicStream(deps: BybitPublicStreamDeps): PublicStream {
  const { ws, bus, clock, resolveCanonical, resolveVenue, restFundingAll, restTicker } = deps

  // Subscribed sets (canonical). Both gate the one `tickers` topic per symbol.
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

  /** `subscribeV5` fans out one promise per connection; await them all as one step. */
  async function subscribeTopics(topics: string[]): Promise<void> {
    if (topics.length === 0) return
    await Promise.all(ws.subscribeV5(topics, CATEGORY))
  }

  async function unsubscribeTopics(topics: string[]): Promise<void> {
    if (topics.length === 0) return
    await Promise.all(ws.unsubscribeV5(topics, CATEGORY))
  }

  /** Dispatch one frame → pure maps → publish. Never throws into the socket lib. */
  function onUpdate(msg: unknown): void {
    try {
      if (!isTickerFrame(msg)) return
      const funding = tickerToFundingPredicted(msg, resolveFunding, clock.now)
      if (funding !== null) bus.publish(funding)
      const tick = tickerToMarketTick(msg, resolveTick, clock.now)
      if (tick !== null) bus.publish(tick)
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

  ws.on('update', onUpdate)
  ws.on('reconnect', () => reconnect.markDisconnected())
  ws.on('reconnected', () => reconnect.markReconnected())

  return {
    async subscribe(symbols: readonly string[]): Promise<void> {
      // The universe is re-declared wholesale on every registry refresh, and each symbol
      // costs its own subscription here — so diff it: subscribe the additions, drop the
      // symbols that left (unless the tick shortlist still needs the shared topic).
      const next = new Set(symbols)
      const added: string[] = []
      const removed: string[] = []
      for (const symbol of next) {
        if (!fundingUniverse.has(symbol) && !tickSymbols.has(symbol)) added.push(tickerTopic(resolveVenue(symbol)))
      }
      for (const symbol of fundingUniverse) {
        if (!next.has(symbol) && !tickSymbols.has(symbol)) removed.push(tickerTopic(resolveVenue(symbol)))
      }
      fundingUniverse.clear()
      for (const symbol of next) fundingUniverse.add(symbol)
      await subscribeTopics(added)
      await unsubscribeTopics(removed)
    },
    async subscribeTicks(symbols: readonly string[]): Promise<void> {
      const topics: string[] = []
      for (const symbol of symbols) {
        // Already covered by the funding universe → the topic is live, only the gate changes.
        if (!tickSymbols.has(symbol) && !fundingUniverse.has(symbol)) topics.push(tickerTopic(resolveVenue(symbol)))
        tickSymbols.add(symbol)
      }
      await subscribeTopics(topics)
    },
    async unsubscribeTicks(symbols: readonly string[]): Promise<void> {
      const topics: string[] = []
      for (const symbol of symbols) {
        tickSymbols.delete(symbol)
        // The one topic serves both signals — keep it while funding still needs it.
        if (!fundingUniverse.has(symbol)) topics.push(tickerTopic(resolveVenue(symbol)))
      }
      await unsubscribeTopics(topics)
    },
    close(): Promise<void> {
      ws.closeAll()
      return Promise.resolve()
    },
  }
}
