/**
 * OKX public market-data WS stream (`10_exchange_adapters_and_market_data.md` §7) — same
 * pipeline as the two siblings (raw frame → type guard → pure map → `bus.publish`), same
 * shared reconnect FSM, different venue shape.
 *
 * The venue quirk that shapes this file: **OKX splits what Bybit fuses.** Bybit's single
 * `tickers.<SYM>` topic carries the funding rate *and* the last price, which is why its
 * stream reference-counts one topic between the funding universe and the tick shortlist.
 * OKX publishes two independent channels — `funding-rate` (→ `FundingPredicted`) and
 * `tickers` (→ `MarketTick`) — each subscribed per `instId`. So the refcount disappears
 * entirely: each set owns its own channel and `unsubscribeTicks` can always drop the
 * `tickers` subscription. It also means the funding universe costs N `funding-rate`
 * subscriptions with no all-symbol alternative (as on Bybit, unlike Binance's one
 * `!markPrice@arr@1s`); the REST fallback is still a single call, since OKX's
 * `GET /api/v5/public/funding-rate` accepts `instId=ANY` (ccxt `fetchFundingRates`).
 *
 * Unlike Bybit, OKX frames are **full snapshots, not deltas** — every push carries the whole
 * row. The mappers still return `null` for an absent/blank field rather than publishing a
 * zero: OKX writes `""` for "no value", and `Number('')` is `0`, which would poison the
 * freshness gate and the sizing math exactly the same way.
 */

import type { FundingPredicted, MarketTick } from '../../../core/events/types.js'
import type { EventBus } from '../../../core/ports/bus.js'
import type { Clock } from '../../../core/ports/clock.js'
import type { PublicStream, Rate } from '../../../core/ports/exchange-adapter.js'
import type { ReconnectController } from '../../shared/reconnect.js'
import { createReconnectController } from '../../shared/reconnect.js'

/** REST fallback poll cadence while degraded — well inside the 60 s freshness gate (`00_globals.md` §7). */
const FALLBACK_POLL_MS = 15_000

/** A last-price reading from the REST ticker fallback. */
export interface TickerReading {
  readonly price: number
  readonly ts: number
}

/** One `funding-rate` row (`GET /api/v5/public/funding-rate` shape, all strings). */
export interface OkxFundingRateRow {
  readonly instId?: string
  /** Funding rate as a decimal fraction (`0.0001` = 1 bp); `""` when the venue has no value. */
  readonly fundingRate?: string
  /** Push time, epoch ms as a string. */
  readonly ts?: string
}

/** One `tickers` row (`GET /api/v5/market/ticker` shape, all strings). */
export interface OkxTickerRow {
  readonly instId?: string
  /** Last traded price; `""` before the first trade. */
  readonly last?: string
  readonly ts?: string
}

/** A public push frame as it arrives: `{arg: {channel, instId}, data: [row, …]}`. */
export interface OkxPublicFrame<T> {
  readonly arg?: { readonly channel?: string; readonly instId?: string }
  readonly data?: readonly T[]
}

/** Parse an OKX numeric string field; `undefined` for absent/empty/unparsable (`""` is not 0). */
function num(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** True when the frame is the named public channel carrying a data array. */
export function isChannelFrame<T>(msg: unknown, channel: string): msg is OkxPublicFrame<T> {
  if (typeof msg !== 'object' || msg === null) return false
  const arg = (msg as { arg?: unknown }).arg
  if (typeof arg !== 'object' || arg === null || (arg as { channel?: unknown }).channel !== channel) return false
  return Array.isArray((msg as { data?: unknown }).data)
}

/**
 * Map one `funding-rate` row to `FundingPredicted`. Returns `null` when the row carries no
 * usable rate or the symbol does not resolve — `resolveCanonical` folds the venue id and
 * gates on the subscribed universe. `rate = fundingRate·100` (decimal → signed percent, the
 * `adapter.ts` convention).
 */
export function fundingRowToFundingPredicted(
  row: OkxFundingRateRow,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  now: () => number,
): FundingPredicted | null {
  if (typeof row.instId !== 'string') return null
  const rate = num(row.fundingRate)
  if (rate === undefined) return null
  const symbol = resolveCanonical(row.instId)
  if (symbol === undefined) return null
  return { type: 'FundingPredicted', symbol, rate: rate * 100, ts: num(row.ts) ?? now() }
}

/** Map one `tickers` row to `MarketTick`; `null` on a blank `last` or an unresolved symbol. */
export function tickerRowToMarketTick(
  row: OkxTickerRow,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  now: () => number,
): MarketTick | null {
  if (typeof row.instId !== 'string') return null
  const price = num(row.last)
  if (price === undefined) return null
  const symbol = resolveCanonical(row.instId)
  if (symbol === undefined) return null
  return { type: 'MarketTick', symbol, price, ts: num(row.ts) ?? now() }
}

/**
 * One channel subscription arg, the shape the native lib's `subscribe`/`unsubscribe` take.
 * OKX scopes a channel by `instId` (the public per-symbol channels) or by `instType` (the
 * private account-wide ones, `./private-stream.ts`), and some by neither.
 */
export interface OkxChannelArg {
  readonly channel: string
  readonly instId?: string
  readonly instType?: string
}

/** The slice of the native `WebsocketClient` the public stream uses. */
export interface OkxWsClient {
  /** Returns one promise per underlying connection (the lib fans out), hence the array. */
  subscribe(args: OkxChannelArg[] | OkxChannelArg, isPrivateTopic?: boolean): Promise<unknown>[]
  unsubscribe(args: OkxChannelArg[] | OkxChannelArg, isPrivateTopic?: boolean): Promise<unknown>[]
  on(event: string, listener: (arg: unknown) => void): unknown
  closeAll(force?: boolean): void
}

export interface OkxPublicStreamDeps {
  readonly ws: OkxWsClient
  readonly bus: EventBus
  readonly clock: Clock
  /** Venue id → canonical name off the live registry (`BTC-USDT-SWAP` → `BTC`), else `undefined`. */
  resolveCanonical(venueSymbol: string): string | undefined
  /** Canonical name → exact `instId`, for building per-symbol channel args. */
  resolveVenue(symbol: string): string
  /**
   * Bulk predicted-funding read (adapter's `instId=ANY` ccxt `fetchFundingRates`) — one call
   * replaces the per-symbol fan-out in the fallback poll/reprime. Keyed by venue symbol;
   * gated to the subscribed universe via `resolveFunding` before publish.
   */
  restFundingAll(): Promise<ReadonlyMap<string, Rate>>
  /** REST last-price read — the tick fallback/reprime source. */
  restTicker(symbol: string): Promise<TickerReading>
}

export function createOkxPublicStream(deps: OkxPublicStreamDeps): PublicStream {
  const { ws, bus, clock, resolveCanonical, resolveVenue, restFundingAll, restTicker } = deps

  // Subscribed sets (canonical). Each gates — and owns — its own channel.
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

  /** `subscribe` fans out one promise per connection; await them all as one step. */
  async function subscribeArgs(args: OkxChannelArg[]): Promise<void> {
    if (args.length === 0) return
    await Promise.all(ws.subscribe(args))
  }

  async function unsubscribeArgs(args: OkxChannelArg[]): Promise<void> {
    if (args.length === 0) return
    await Promise.all(ws.unsubscribe(args))
  }

  /** Dispatch one frame → pure maps → publish. Never throws into the socket lib. */
  function onUpdate(msg: unknown): void {
    try {
      if (isChannelFrame<OkxFundingRateRow>(msg, 'funding-rate')) {
        for (const row of msg.data ?? []) {
          const event = fundingRowToFundingPredicted(row, resolveFunding, clock.now)
          if (event !== null) bus.publish(event)
        }
        return
      }
      if (isChannelFrame<OkxTickerRow>(msg, 'tickers')) {
        for (const row of msg.data ?? []) {
          const event = tickerRowToMarketTick(row, resolveTick, clock.now)
          if (event !== null) bus.publish(event)
        }
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

  ws.on('update', onUpdate)
  ws.on('reconnect', () => reconnect.markDisconnected())
  ws.on('reconnected', () => reconnect.markReconnected())

  return {
    async subscribe(symbols: readonly string[]): Promise<void> {
      // The universe is re-declared wholesale on every registry refresh and each symbol costs
      // its own subscription, so diff it. No refcount against the tick shortlist here: the
      // `funding-rate` channel is this set's alone (the Bybit sibling's shared topic is not).
      const next = new Set(symbols)
      const added: OkxChannelArg[] = []
      const removed: OkxChannelArg[] = []
      for (const symbol of next) {
        if (!fundingUniverse.has(symbol)) added.push({ channel: 'funding-rate', instId: resolveVenue(symbol) })
      }
      for (const symbol of fundingUniverse) {
        if (!next.has(symbol)) removed.push({ channel: 'funding-rate', instId: resolveVenue(symbol) })
      }
      fundingUniverse.clear()
      for (const symbol of next) fundingUniverse.add(symbol)
      await subscribeArgs(added)
      await unsubscribeArgs(removed)
    },
    async subscribeTicks(symbols: readonly string[]): Promise<void> {
      const args: OkxChannelArg[] = []
      for (const symbol of symbols) {
        if (!tickSymbols.has(symbol)) args.push({ channel: 'tickers', instId: resolveVenue(symbol) })
        tickSymbols.add(symbol)
      }
      await subscribeArgs(args)
    },
    async unsubscribeTicks(symbols: readonly string[]): Promise<void> {
      const args: OkxChannelArg[] = []
      for (const symbol of symbols) {
        if (tickSymbols.delete(symbol)) args.push({ channel: 'tickers', instId: resolveVenue(symbol) })
      }
      await unsubscribeArgs(args)
    },
    close(): Promise<void> {
      ws.closeAll()
      return Promise.resolve()
    },
  }
}
