/**
 * Unit: Bybit public market-data stream (`10` §7). Offline against a fake `WebsocketClient`
 * emitter + fake bus. Focus on the venue quirks the Binance sibling does not have:
 *  - **one `tickers.<SYM>` topic carries both signals**, so a single frame can publish a
 *    `FundingPredicted` *and* a `MarketTick`, and the topic is reference-counted between the
 *    funding universe and the tick shortlist;
 *  - **frames are deltas**, so a frame with no `lastPrice`/`fundingRate` must publish nothing
 *    rather than a zero.
 */

import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import {
  type BybitTickerFrame,
  type BybitWsClient,
  createBybitPublicStream,
  type TickerReading,
  tickerToFundingPredicted,
  tickerToMarketTick,
} from '../../../../../src/adapters/exchanges/bybit/public-stream.js'
import type { EngineEvent } from '../../../../../src/core/events/types.js'
import type { EventBus } from '../../../../../src/core/ports/bus.js'
import type { Rate } from '../../../../../src/core/ports/exchange-adapter.js'
import { CAPTURED_TICKER_DELTA, CAPTURED_TICKER_SNAPSHOT } from './ws-fixtures.js'

/**
 * A `tickers.<SYM>` snapshot frame, defaults taken from the **captured** venue frame
 * (`./ws-fixtures.ts`) so unoverridden fields carry real values.
 */
function snapshot(symbol: string, data: Record<string, string>, ts = 1_000): BybitTickerFrame {
  return {
    ...CAPTURED_TICKER_SNAPSHOT,
    topic: `tickers.${symbol}`,
    type: 'snapshot',
    ts,
    data: { ...CAPTURED_TICKER_SNAPSHOT.data, symbol, ...data },
  }
}

/** A delta frame: only the fields the test names are present (the venue's own delta shape). */
function delta(symbol: string, data: Record<string, string>, ts = 2_000): BybitTickerFrame {
  return { topic: `tickers.${symbol}`, type: 'delta', ts, data: { symbol, ...data } }
}

// Registry: venue id → canonical, folding the 1000-multiplier like the real adapter.
const VENUE_TO_CANONICAL: Record<string, string> = { BTCUSDT: 'BTC', '1000PEPEUSDT': 'PEPE' }
const CANONICAL_TO_VENUE: Record<string, string> = { BTC: 'BTCUSDT', PEPE: '1000PEPEUSDT' }
const resolveAny = (venue: string): string | undefined => VENUE_TO_CANONICAL[venue]
const now = (): number => 777

describe('pure mappers', () => {
  it('maps ticker funding decimal → signed percent, ts from the frame', () => {
    const event = tickerToFundingPredicted(
      snapshot('BTCUSDT', { fundingRate: '0.0001', nextFundingTime: '1700000000000' }, 42),
      resolveAny,
      now,
    )
    expect(event).toEqual({ type: 'FundingPredicted', symbol: 'BTC', rate: 0.01, ts: 42 })
  })

  it('folds a multiplier symbol via the resolver', () => {
    const event = tickerToFundingPredicted(snapshot('1000PEPEUSDT', { fundingRate: '-0.0005' }), resolveAny, now)
    expect(event).toMatchObject({ symbol: 'PEPE', rate: -0.05 })
  })

  it('a delta frame without fundingRate publishes no FundingPredicted (never a zero rate)', () => {
    expect(tickerToFundingPredicted(delta('BTCUSDT', { lastPrice: '61000' }), resolveAny, now)).toBeNull()
    expect(tickerToFundingPredicted(delta('BTCUSDT', { fundingRate: '' }), resolveAny, now)).toBeNull()
  })

  it('the captured real delta frame (bid/ask only) publishes neither event', () => {
    expect(tickerToFundingPredicted(CAPTURED_TICKER_DELTA, resolveAny, now)).toBeNull()
    expect(tickerToMarketTick(CAPTURED_TICKER_DELTA, resolveAny, now)).toBeNull()
  })

  it('a delta frame without lastPrice publishes no MarketTick (never a zero price)', () => {
    expect(tickerToMarketTick(delta('BTCUSDT', { fundingRate: '0.0001' }), resolveAny, now)).toBeNull()
  })

  it('maps ticker lastPrice → MarketTick', () => {
    const tick = tickerToMarketTick(delta('BTCUSDT', { lastPrice: '60050.5' }, 99), resolveAny, now)
    expect(tick).toEqual({ type: 'MarketTick', symbol: 'BTC', price: 60_050.5, ts: 99 })
  })

  it('falls back to the clock when the frame carries no ts', () => {
    const tick = tickerToMarketTick(
      { topic: 'tickers.BTCUSDT', data: { symbol: 'BTCUSDT', lastPrice: '1' } },
      resolveAny,
      now,
    )
    expect(tick).toMatchObject({ ts: 777 })
  })

  it('returns null for an unknown symbol', () => {
    expect(tickerToFundingPredicted(snapshot('DOGEUSDT', { fundingRate: '0.001' }), resolveAny, now)).toBeNull()
    expect(tickerToMarketTick(snapshot('DOGEUSDT', { lastPrice: '1' }), resolveAny, now)).toBeNull()
  })
})

// ── Wired-stream harness (fake ws emitter + fake bus) ─────────────────────────

interface FakeWs extends BybitWsClient {
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
    subscribeV5(topics) {
      this.subscribed.push(asTopics(topics))
      return [Promise.resolve()]
    },
    unsubscribeV5(topics) {
      this.unsubscribed.push(asTopics(topics))
      return [Promise.resolve()]
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
  restFundingAll?: () => Promise<ReadonlyMap<string, Rate>>
  restTicker?: (symbol: string) => Promise<TickerReading>
}) {
  const clock = createVirtualClock(0)
  const ws = makeFakeWs()
  const { bus, events } = makeBus()
  const restFundingAll =
    overrides?.restFundingAll ??
    (() => Promise.resolve(new Map([['BTCUSDT', { symbol: 'BTCUSDT', rate: 0.02, ts: 500 }]])))
  const restTicker = overrides?.restTicker ?? ((_symbol: string) => Promise.resolve({ price: 61_000, ts: 700 }))
  const stream = createBybitPublicStream({
    ws,
    bus,
    clock,
    resolveCanonical: resolveAny,
    resolveVenue: (symbol) => CANONICAL_TO_VENUE[symbol] ?? symbol,
    restFundingAll,
    restTicker,
  })
  return { clock, ws, bus, events, stream }
}

describe('createBybitPublicStream — live WS flow', () => {
  it('subscribe wires one tickers topic per symbol (no all-symbol stream on this venue)', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC', 'PEPE'])
    expect(ws.subscribed).toEqual([['tickers.BTCUSDT', 'tickers.1000PEPEUSDT']])
  })

  it('one snapshot frame publishes both FundingPredicted and MarketTick', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])
    ws.emit('update', snapshot('BTCUSDT', { fundingRate: '0.0003', lastPrice: '60100' }, 10))
    expect(events).toEqual([
      { type: 'FundingPredicted', symbol: 'BTC', rate: 0.03, ts: 10 },
      { type: 'MarketTick', symbol: 'BTC', price: 60_100, ts: 10 },
    ])
  })

  it('gates funding to the subscribed universe (registry-known but unsubscribed symbol is dropped)', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC']) // PEPE resolves in the registry but is not subscribed
    ws.emit('update', snapshot('1000PEPEUSDT', { fundingRate: '0.0002' }))
    expect(events).toEqual([])
  })

  it('gates ticks to the shortlist — a funding-only symbol publishes no MarketTick', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC']) // funding universe only, no subscribeTicks
    ws.emit('update', snapshot('BTCUSDT', { fundingRate: '0.0001', lastPrice: '60000' }, 7))
    expect(events).toEqual([{ type: 'FundingPredicted', symbol: 'BTC', rate: 0.01, ts: 7 }])
  })

  it('reference-counts the shared topic: subscribeTicks on a funding symbol adds no subscription', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])
    expect(ws.subscribed).toEqual([['tickers.BTCUSDT']])
  })

  it('unsubscribeTicks keeps the topic while funding still needs it, drops it otherwise', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC']) // BTC also in the funding universe
    await stream.subscribeTicks(['BTC', 'PEPE']) // PEPE is tick-only
    await stream.unsubscribeTicks(['BTC', 'PEPE'])
    expect(ws.subscribed).toEqual([['tickers.BTCUSDT'], ['tickers.1000PEPEUSDT']])
    expect(ws.unsubscribed).toEqual([['tickers.1000PEPEUSDT']])
  })

  it('a re-declared universe diffs: subscribes the additions, drops the symbols that left', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribe(['PEPE']) // BTC leaves, PEPE joins
    expect(ws.subscribed).toEqual([['tickers.BTCUSDT'], ['tickers.1000PEPEUSDT']])
    expect(ws.unsubscribed).toEqual([['tickers.BTCUSDT']])
  })

  it('a re-declared universe keeps a topic the tick shortlist still needs', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])
    await stream.subscribe(['PEPE'])
    expect(ws.unsubscribed).toEqual([])
  })

  it('tolerates duplicate frames — idempotent mapping, publishes each, never throws', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    const frame = snapshot('BTCUSDT', { fundingRate: '0.0001' }, 5)
    expect(() => {
      ws.emit('update', frame)
      ws.emit('update', frame)
    }).not.toThrow()
    expect(events).toEqual([
      { type: 'FundingPredicted', symbol: 'BTC', rate: 0.01, ts: 5 },
      { type: 'FundingPredicted', symbol: 'BTC', rate: 0.01, ts: 5 },
    ])
  })

  it('never throws into the socket lib on a malformed frame', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    expect(() => ws.emit('update', undefined)).not.toThrow()
    expect(() => ws.emit('update', { topic: 'orderbook.1.BTCUSDT' })).not.toThrow()
    expect(() => ws.emit('update', { topic: 'tickers.BTCUSDT' })).not.toThrow()
  })

  it('close() closes the socket', async () => {
    const { ws, stream } = build()
    await stream.close()
    expect(ws.closed).toBe(1)
  })
})

describe('createBybitPublicStream — disconnect / fallback / reprime', () => {
  it('polls REST while degraded and stops on recover, reprime before resume', async () => {
    const restFundingAll = vi.fn(() =>
      Promise.resolve<ReadonlyMap<string, Rate>>(new Map([['BTCUSDT', { symbol: 'BTCUSDT', rate: 0.02, ts: 500 }]])),
    )
    const { clock, ws, events, stream } = build({ restFundingAll })
    await stream.subscribe(['BTC'])

    // Disconnect → degraded: one immediate fallback poll (one bulk call) publishes via REST.
    ws.emit('reconnect', {})
    await flush()
    expect(restFundingAll).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual({ type: 'FundingPredicted', symbol: 'BTC', rate: 0.02, ts: 500 })

    // Poll self-reschedules on the virtual clock while still degraded.
    clock.advanceBy(15_000)
    await flush()
    expect(restFundingAll).toHaveBeenCalledTimes(2)

    // Reconnect → reprime (one more REST snapshot) BEFORE the fallback stops.
    ws.emit('reconnected', {})
    await flush()
    const reprimeCount = restFundingAll.mock.calls.length
    expect(reprimeCount).toBe(3)

    // Once live, the fallback poll no longer fires on further clock advances.
    clock.advanceBy(15_000 * 5)
    await flush()
    expect(restFundingAll).toHaveBeenCalledTimes(reprimeCount)
  })

  it('bulk poll gates each returned symbol to the subscribed funding universe', async () => {
    const restFundingAll = () =>
      Promise.resolve<ReadonlyMap<string, Rate>>(
        new Map([
          ['BTCUSDT', { symbol: 'BTCUSDT', rate: 0.02, ts: 500 }],
          ['DOGEUSDT', { symbol: 'DOGEUSDT', rate: 0.09, ts: 500 }], // not in registry
        ]),
      )
    const { ws, events, stream } = build({ restFundingAll })
    await stream.subscribe(['BTC'])

    ws.emit('reconnect', {})
    await flush()

    expect(events).toEqual([{ type: 'FundingPredicted', symbol: 'BTC', rate: 0.02, ts: 500 }])
  })
})

/** Drain the microtask + resolved-promise chain the REST poll schedules. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}
