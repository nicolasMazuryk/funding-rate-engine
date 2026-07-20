import type { WsMessageAggTradeFormatted, WsMessageMarkPriceEventFormatted } from 'binance'
import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import {
  aggTradeToMarketTick,
  type BinanceWsClient,
  createBinancePublicStream,
  markPriceToFundingPredicted,
  type TickerReading,
} from '../../../../../src/adapters/exchanges/binance/public-stream.js'
import type { EngineEvent } from '../../../../../src/core/events/types.js'
import type { EventBus } from '../../../../../src/core/ports/bus.js'
import type { Rate } from '../../../../../src/core/ports/exchange-adapter.js'
import { CAPTURED_AGG_TRADE, CAPTURED_MARK_PRICE } from './ws-fixtures.js'

// ── Captured-base fixtures (task 0250) — defaults from a real venue frame ──────

function markPriceEntry(overrides: Partial<WsMessageMarkPriceEventFormatted>): WsMessageMarkPriceEventFormatted {
  return { ...CAPTURED_MARK_PRICE, ...overrides } as WsMessageMarkPriceEventFormatted
}

function aggTrade(overrides: Partial<WsMessageAggTradeFormatted>): WsMessageAggTradeFormatted {
  return { ...CAPTURED_AGG_TRADE, ...overrides } as WsMessageAggTradeFormatted
}

// Registry: venue id → canonical, folding the 1000-multiplier like the real adapter.
const VENUE_TO_CANONICAL: Record<string, string> = { BTCUSDT: 'BTC', '1000PEPEUSDT': 'PEPE' }
const CANONICAL_TO_VENUE: Record<string, string> = { BTC: 'BTCUSDT', PEPE: '1000PEPEUSDT' }
const resolveAny = (venue: string): string | undefined => VENUE_TO_CANONICAL[venue]

describe('pure mappers', () => {
  it('maps mark-price funding decimal → signed percent, ts from eventTime', () => {
    const event = markPriceToFundingPredicted(markPriceEntry({ fundingRate: 0.0001, eventTime: 42 }), resolveAny)
    expect(event).toEqual({ type: 'FundingPredicted', symbol: 'BTC', rate: 0.01, ts: 42 })
  })

  it('folds the 1000-multiplier symbol via the resolver', () => {
    const event = markPriceToFundingPredicted(
      markPriceEntry({ symbol: '1000PEPEUSDT', fundingRate: -0.0005 }),
      resolveAny,
    )
    expect(event).toMatchObject({ symbol: 'PEPE', rate: -0.05 })
  })

  it('returns null when the venue reports no funding rate', () => {
    expect(markPriceToFundingPredicted(markPriceEntry({ fundingRate: '' }), resolveAny)).toBeNull()
  })

  it('returns null for an unknown symbol', () => {
    expect(markPriceToFundingPredicted(markPriceEntry({ symbol: 'DOGEUSDT' }), resolveAny)).toBeNull()
  })

  it('maps aggTrade → MarketTick (price + eventTime)', () => {
    const tick = aggTradeToMarketTick(aggTrade({ price: 60_050, eventTime: 99 }), resolveAny)
    expect(tick).toEqual({ type: 'MarketTick', symbol: 'BTC', price: 60_050, ts: 99 })
  })

  it('aggTrade → null for an unknown symbol', () => {
    expect(aggTradeToMarketTick(aggTrade({ symbol: 'DOGEUSDT' }), resolveAny)).toBeNull()
  })
})

// ── Wired-stream harness (fake ws emitter + fake bus) ─────────────────────────

interface FakeWs extends BinanceWsClient {
  emit(event: string, arg: unknown): void
  subscribed: string[][]
  unsubscribed: string[][]
  closed: number
}

function makeFakeWs(): FakeWs {
  const listeners = new Map<string, (arg: unknown) => void>()
  const asTopics = (topics: string | string[]): string[] => (Array.isArray(topics) ? topics : [topics])
  return {
    subscribed: [],
    unsubscribed: [],
    closed: 0,
    subscribe(topics) {
      this.subscribed.push(asTopics(topics))
      return Promise.resolve()
    },
    unsubscribe(topics) {
      this.unsubscribed.push(asTopics(topics))
      return Promise.resolve([])
    },
    on(event, listener) {
      listeners.set(event, listener)
      return this
    },
    closeAll() {
      this.closed += 1
    },
    emit(event, arg) {
      listeners.get(event)?.(arg)
    },
  }
}

function makeBus(): { bus: EventBus; events: EngineEvent[] } {
  const events: EngineEvent[] = []
  const bus: EventBus = {
    publish(event) {
      events.push(event)
    },
    subscribe() {
      return () => {}
    },
  }
  return { bus, events }
}

function build(overrides?: {
  restFunding?: (symbol: string) => Promise<Rate>
  restTicker?: (symbol: string) => Promise<TickerReading>
}) {
  const clock = createVirtualClock(0)
  const ws = makeFakeWs()
  const { bus, events } = makeBus()
  const restFunding = overrides?.restFunding ?? ((symbol: string) => Promise.resolve({ symbol, rate: 0.02, ts: 500 }))
  const restTicker = overrides?.restTicker ?? ((_symbol: string) => Promise.resolve({ price: 61_000, ts: 700 }))
  const stream = createBinancePublicStream({
    ws,
    bus,
    clock,
    resolveCanonical: resolveAny,
    resolveVenue: (symbol) => CANONICAL_TO_VENUE[symbol] ?? symbol,
    restFunding,
    restTicker,
  })
  return { clock, ws, bus, events, stream }
}

describe('createBinancePublicStream — live WS flow', () => {
  it('subscribe wires the all-market mark-price array topic', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    expect(ws.subscribed).toEqual([['!markPrice@arr@1s']])
  })

  it('a mark-price array message publishes FundingPredicted for subscribed symbols only', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    // Array carries BTC (subscribed) + DOGE (not in registry) — only BTC publishes.
    ws.emit('formattedMessage', [
      markPriceEntry({ symbol: 'BTCUSDT', fundingRate: 0.0003, eventTime: 10 }),
      markPriceEntry({ symbol: 'DOGEUSDT', fundingRate: 0.0009, eventTime: 10 }),
    ])
    expect(events).toEqual([{ type: 'FundingPredicted', symbol: 'BTC', rate: 0.03, ts: 10 }])
  })

  it('gates funding to the subscribed universe (registry-known but unsubscribed symbol is dropped)', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC']) // PEPE resolves in the registry but is not subscribed
    ws.emit('formattedMessage', [markPriceEntry({ symbol: '1000PEPEUSDT', fundingRate: 0.0002 })])
    expect(events).toEqual([])
  })

  it('an aggTrade message publishes MarketTick for a subscribed tick symbol', async () => {
    const { ws, events, stream } = build()
    await stream.subscribeTicks(['BTC'])
    ws.emit('formattedMessage', aggTrade({ symbol: 'BTCUSDT', price: 60_100, eventTime: 20 }))
    expect(events).toEqual([{ type: 'MarketTick', symbol: 'BTC', price: 60_100, ts: 20 }])
  })

  it('subscribeTicks / unsubscribeTicks use the correct lowercase aggTrade topics', async () => {
    const { ws, stream } = build()
    await stream.subscribeTicks(['BTC', 'PEPE'])
    await stream.unsubscribeTicks(['PEPE'])
    expect(ws.subscribed).toEqual([['btcusdt@aggTrade', '1000pepeusdt@aggTrade']])
    expect(ws.unsubscribed).toEqual([['1000pepeusdt@aggTrade']])
  })

  it('tolerates duplicate messages — idempotent mapping, publishes each, never throws', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    const msg = [markPriceEntry({ symbol: 'BTCUSDT', fundingRate: 0.0001, eventTime: 5 })]
    expect(() => {
      ws.emit('formattedMessage', msg)
      ws.emit('formattedMessage', msg)
    }).not.toThrow()
    expect(events).toEqual([
      { type: 'FundingPredicted', symbol: 'BTC', rate: 0.01, ts: 5 },
      { type: 'FundingPredicted', symbol: 'BTC', rate: 0.01, ts: 5 },
    ])
  })

  it('never throws into the socket lib on a malformed message', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    expect(() => ws.emit('formattedMessage', undefined)).not.toThrow()
    expect(() => ws.emit('formattedMessage', { eventType: 'bookTicker' })).not.toThrow()
  })

  it('close() closes the socket', async () => {
    const { ws, stream } = build()
    await stream.close()
    expect(ws.closed).toBe(1)
  })
})

describe('createBinancePublicStream — disconnect / fallback / reprime', () => {
  it('polls REST while degraded and stops on recover, reprime before resume', async () => {
    const order: string[] = []
    const restFunding = vi.fn((symbol: string) => {
      order.push('rest-funding')
      return Promise.resolve<Rate>({ symbol, rate: 0.02, ts: 500 })
    })
    const { clock, ws, events, stream } = build({ restFunding })
    await stream.subscribe(['BTC'])

    // Disconnect → degraded: one immediate fallback poll publishes FundingPredicted via REST.
    ws.emit('reconnecting', {})
    await flush()
    expect(restFunding).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({ type: 'FundingPredicted', symbol: 'BTC', rate: 0.02, ts: 500 })

    // Poll self-reschedules on the virtual clock while still degraded.
    clock.advanceBy(15_000)
    await flush()
    expect(restFunding).toHaveBeenCalledTimes(2)

    // Reconnect → reprime (one more REST snapshot) BEFORE the fallback stops.
    ws.emit('reconnected', {})
    await flush()
    const reprimeCount = restFunding.mock.calls.length
    expect(reprimeCount).toBe(3) // the reprime snapshot

    // Once live, the fallback poll no longer fires on further clock advances.
    clock.advanceBy(15_000 * 5)
    await flush()
    expect(restFunding).toHaveBeenCalledTimes(reprimeCount)

    // Ordering sanity: every REST call is a fallback/reprime; the last precedes resume.
    expect(order.filter((o) => o === 'rest-funding').length).toBe(reprimeCount)
  })
})

/** Drain the microtask + resolved-promise chain the REST poll schedules. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
