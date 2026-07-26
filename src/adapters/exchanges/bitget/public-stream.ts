/**
 * Bitget public market-data WS stream (`10_exchange_adapters_and_market_data.md` §7) — same
 * pipeline as the three siblings (raw frame → type guard → pure map → `bus.publish`), same
 * shared reconnect FSM, different venue shape.
 *
 * The venue quirks that shape this file, all read off the captured `public-ws` fixtures
 * (`test/fixtures/bitget/public-ws/frames.jsonl`) rather than from recall:
 *  - **One topic, both signals** — Bybit's shape, not OKX's. A v3 futures `ticker` frame
 *    carries `lastPrice` (→ `MarketTick`) *and* `fundingRate` + `nextFundingTime`
 *    (→ `FundingPredicted`). So one subscription per symbol serves both port methods, and the
 *    topic is **reference-counted** between the funding universe and the tick shortlist:
 *    `unsubscribeTicks` only drops it for a symbol outside the funding universe.
 *  - **The symbol lives on `arg`, not on the row.** The data row carries prices only; the
 *    subscription echo (`arg.symbol`) is the only place the instrument appears.
 *  - **Frames are full snapshots** (`action: 'snapshot'` on every push, unlike Bybit's deltas),
 *    but the mappers still return `null` for an absent or blank field rather than publishing a
 *    zero: Bitget writes `""` for "no value" and `Number('')` is `0`, which would poison the
 *    freshness gate and the sizing math exactly the same way.
 *  - **No all-symbol funding stream** (as on Bybit and OKX, unlike Binance's one
 *    `!markPrice@arr@1s`), so the funding universe costs N subscriptions. The REST fallback is
 *    still a single call — ccxt `fetchFundingRates` reads the all-symbol tickers endpoint.
 */

import type { FundingPredicted, MarketTick } from '../../../core/events/types.js'
import type { EventBus } from '../../../core/ports/bus.js'
import type { Clock } from '../../../core/ports/clock.js'
import type { PublicStream, Rate } from '../../../core/ports/exchange-adapter.js'
import type { ReconnectController } from '../../shared/reconnect.js'
import { createReconnectController } from '../../shared/reconnect.js'

/**
 * The linear-USDT product as the **WS** surface spells it. Bitget uses two casings for one
 * product: REST takes `USDT-FUTURES`, the WS `instType` (and the WS trade API's `category`)
 * takes `usdt-futures`. Live and demo trading share it — demo differs only by host.
 */
export const WS_INST_TYPE = 'usdt-futures' as const

/** The one public topic this stream subscribes; it fuses funding and last price. */
const TICKER_TOPIC = 'ticker' as const

/** REST fallback poll cadence while degraded — well inside the 60 s freshness gate (`00_globals.md` §7). */
const FALLBACK_POLL_MS = 15_000

/** A last-price reading from the REST ticker fallback. */
export interface TickerReading {
  readonly price: number
  readonly ts: number
}

/** One `ticker` data row (futures shape — every value is a string). */
export interface BitgetTickerRow {
  /** Latest traded price; `""` before the first trade. */
  readonly lastPrice?: string
  /** Funding rate as a decimal fraction (`0.0001` = 1 bp); `""` when the venue has no value. */
  readonly fundingRate?: string
  readonly nextFundingTime?: string
  readonly markPrice?: string
  readonly indexPrice?: string
}

/** A public push frame as it arrives: `{arg: {instType, symbol, topic}, data: [row], ts}`. */
export interface BitgetPublicFrame<T> {
  readonly arg?: { readonly instType?: string; readonly symbol?: string; readonly topic?: string }
  readonly action?: string
  readonly ts?: number
  readonly data?: readonly T[]
}

/** Parse a Bitget numeric string field; `undefined` for absent/empty/unparsable (`""` is not 0). */
function num(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** True when the frame is the named public topic carrying a data array. */
export function isTopicFrame<T>(msg: unknown, topic: string): msg is BitgetPublicFrame<T> {
  if (typeof msg !== 'object' || msg === null) return false
  const arg = (msg as { arg?: unknown }).arg
  if (typeof arg !== 'object' || arg === null || (arg as { topic?: unknown }).topic !== topic) return false
  return Array.isArray((msg as { data?: unknown }).data)
}

/** The venue symbol a public frame is for — carried on the subscription echo, not on the row. */
function frameSymbol(frame: BitgetPublicFrame<unknown>): string | undefined {
  const symbol = frame.arg?.symbol
  return typeof symbol === 'string' && symbol.length > 0 ? symbol : undefined
}

/**
 * Map one `ticker` frame to `FundingPredicted`. Returns `null` when the frame carries no usable
 * rate or the symbol does not resolve — `resolveCanonical` folds the venue symbol (`1000BONKUSDT`
 * → `BONK`) and gates on the subscribed universe. `rate = fundingRate·100` (decimal → signed
 * percent, the `adapter.ts` convention).
 */
export function tickerToFundingPredicted(
  frame: BitgetPublicFrame<BitgetTickerRow>,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  now: () => number,
): FundingPredicted | null {
  const venue = frameSymbol(frame)
  if (venue === undefined) return null
  const rate = num(frame.data?.[0]?.fundingRate)
  if (rate === undefined) return null
  const symbol = resolveCanonical(venue)
  if (symbol === undefined) return null
  return { type: 'FundingPredicted', symbol, rate: rate * 100, ts: num(frame.ts) ?? now() }
}

/** Map one `ticker` frame to `MarketTick`; `null` on a blank `lastPrice` or an unresolved symbol. */
export function tickerToMarketTick(
  frame: BitgetPublicFrame<BitgetTickerRow>,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  now: () => number,
): MarketTick | null {
  const venue = frameSymbol(frame)
  if (venue === undefined) return null
  const price = num(frame.data?.[0]?.lastPrice)
  if (price === undefined) return null
  const symbol = resolveCanonical(venue)
  if (symbol === undefined) return null
  return { type: 'MarketTick', symbol, price, ts: num(frame.ts) ?? now() }
}

/**
 * One subscription request, the shape the native v3 lib takes: the topic plus a payload that is
 * spread into the `arg` object on the wire. Public topics scope by `instType` + `symbol`; the
 * private ones (`./private-stream.ts`) scope by `instType: 'UTA'` alone.
 */
export interface BitgetTopicRequest {
  /**
   * Only the topics this adapter actually subscribes. Narrower than `string` on purpose: the
   * native `WebsocketClientV3.subscribe` is typed against the SDK's own topic/`instType`
   * unions, and a `string` here would make the real client un-assignable to this interface
   * (proven when the testnet harness first wired one, task 0440 Phase 2).
   */
  readonly topic: 'ticker' | 'order' | 'position' | 'account'
  readonly payload?: { readonly instType?: 'usdt-futures' | 'UTA'; readonly symbol?: string }
}

/** The slice of the native `WebsocketClientV3` the public stream uses. */
export interface BitgetWsClient {
  /** One promise for the whole batch (the v3 lib routes internally), unlike the OKX SDK's array. */
  subscribe(requests: BitgetTopicRequest[], wsKey: string): Promise<unknown>
  unsubscribe(requests: BitgetTopicRequest[], wsKey: string): Promise<unknown>
  on(event: string, listener: (arg: unknown) => void): unknown
  closeAll(force?: boolean): void
}

export interface BitgetPublicStreamDeps {
  readonly ws: BitgetWsClient
  readonly bus: EventBus
  readonly clock: Clock
  /** The lib's connection key for the public v3 socket (`WS_KEY_MAP.v3Public`). */
  readonly wsKey: string
  /** Venue symbol → canonical name off the live registry (`1000BONKUSDT` → `BONK`), else `undefined`. */
  resolveCanonical(venueSymbol: string): string | undefined
  /** Canonical name → exact venue symbol, for building per-symbol subscription requests. */
  resolveVenue(symbol: string): string
  /**
   * Bulk predicted-funding read (adapter's ccxt `fetchFundingRates`) — one call replaces the
   * per-symbol fan-out in the fallback poll/reprime. Keyed by venue symbol; gated to the
   * subscribed universe via `resolveFunding` before publish.
   */
  restFundingAll(): Promise<ReadonlyMap<string, Rate>>
  /** REST last-price read — the tick fallback/reprime source. */
  restTicker(symbol: string): Promise<TickerReading>
}

/** The `ticker` subscription request for one venue symbol. */
function tickerRequest(venueSymbol: string): BitgetTopicRequest {
  return { topic: TICKER_TOPIC, payload: { instType: WS_INST_TYPE, symbol: venueSymbol } }
}

export function createBitgetPublicStream(deps: BitgetPublicStreamDeps): PublicStream {
  const { ws, bus, clock, wsKey, resolveCanonical, resolveVenue, restFundingAll, restTicker } = deps

  // Subscribed sets (canonical). Both gate the one `ticker` topic per symbol.
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

  async function subscribeRequests(requests: BitgetTopicRequest[]): Promise<void> {
    if (requests.length === 0) return
    await ws.subscribe(requests, wsKey)
  }

  async function unsubscribeRequests(requests: BitgetTopicRequest[]): Promise<void> {
    if (requests.length === 0) return
    await ws.unsubscribe(requests, wsKey)
  }

  /** Dispatch one frame → pure maps → publish. Never throws into the socket lib. */
  function onUpdate(msg: unknown): void {
    try {
      if (!isTopicFrame<BitgetTickerRow>(msg, TICKER_TOPIC)) return
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
      // The universe is re-declared wholesale on every registry refresh and each symbol costs
      // its own subscription, so diff it: subscribe the additions, drop the symbols that left
      // (unless the tick shortlist still needs the shared topic).
      const next = new Set(symbols)
      const added: BitgetTopicRequest[] = []
      const removed: BitgetTopicRequest[] = []
      for (const symbol of next) {
        if (!fundingUniverse.has(symbol) && !tickSymbols.has(symbol)) added.push(tickerRequest(resolveVenue(symbol)))
      }
      for (const symbol of fundingUniverse) {
        if (!next.has(symbol) && !tickSymbols.has(symbol)) removed.push(tickerRequest(resolveVenue(symbol)))
      }
      fundingUniverse.clear()
      for (const symbol of next) fundingUniverse.add(symbol)
      await subscribeRequests(added)
      await unsubscribeRequests(removed)
    },
    async subscribeTicks(symbols: readonly string[]): Promise<void> {
      const requests: BitgetTopicRequest[] = []
      for (const symbol of symbols) {
        // Already covered by the funding universe → the topic is live, only the gate changes.
        if (!tickSymbols.has(symbol) && !fundingUniverse.has(symbol)) requests.push(tickerRequest(resolveVenue(symbol)))
        tickSymbols.add(symbol)
      }
      await subscribeRequests(requests)
    },
    async unsubscribeTicks(symbols: readonly string[]): Promise<void> {
      const requests: BitgetTopicRequest[] = []
      for (const symbol of symbols) {
        tickSymbols.delete(symbol)
        // The one topic serves both signals — keep it while funding still needs it.
        if (!fundingUniverse.has(symbol)) requests.push(tickerRequest(resolveVenue(symbol)))
      }
      await unsubscribeRequests(requests)
    },
    close(): Promise<void> {
      ws.closeAll()
      return Promise.resolve()
    },
  }
}
