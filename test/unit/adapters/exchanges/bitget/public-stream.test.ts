/**
 * Unit: Bitget public market-data stream (`10` §7). Offline against a fake `WebsocketClientV3`
 * emitter + fake bus, on the virtual clock. Focus on the venue quirks that shape the file:
 *  - **one fused `ticker` topic carries both signals** (Bybit's shape, not OKX's two channels),
 *    so a single frame can publish a `FundingPredicted` *and* a `MarketTick`, and the topic is
 *    **reference-counted** between the funding universe and the tick shortlist — the pair of
 *    bugs worth pinning is dropping a topic funding still needs, and double-subscribing one
 *    funding already holds;
 *  - **the instrument lives on `arg.symbol`**, never on the data row, so a frame without it
 *    resolves to nothing;
 *  - frames are full snapshots, but Bitget writes `""` for "no value" and `Number('')` is `0`,
 *    so a blank field must publish nothing rather than a zero price/rate that would sail
 *    through the freshness gate and poison sizing.
 */

import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import {
  type BitgetPublicFrame,
  type BitgetTickerRow,
  type BitgetTopicRequest,
  type BitgetWsClient,
  createBitgetPublicStream,
  type TickerReading,
  tickerToFundingPredicted,
  tickerToMarketTick,
  WS_INST_TYPE,
} from '../../../../../src/adapters/exchanges/bitget/public-stream.js'
import type { EngineEvent } from '../../../../../src/core/events/types.js'
import type { EventBus } from '../../../../../src/core/ports/bus.js'
import type { Rate } from '../../../../../src/core/ports/exchange-adapter.js'
import { CAPTURED_TICKER_FRAME, CAPTURED_TICKER_ROW } from './ws-fixtures.js'

/** The lib's connection key for the public v3 socket, as the factory passes it. */
const WS_KEY = 'v3Public'

/** The subscription request the stream is expected to hand the lib for one venue symbol. */
const tickerSub = (venueSymbol: string): BitgetTopicRequest => ({
  topic: 'ticker',
  payload: { instType: WS_INST_TYPE, symbol: venueSymbol },
})

/**
 * A `ticker` push frame in the venue's own envelope, defaults taken from the **captured** frame
 * (`./ws-fixtures.ts`) so unoverridden fields carry real venue bytes.
 */
function frame(
  venueSymbol: string,
  over: Partial<BitgetTickerRow> = {},
  ts = 1_000,
): BitgetPublicFrame<BitgetTickerRow> {
  return {
    ...CAPTURED_TICKER_FRAME,
    arg: { ...CAPTURED_TICKER_FRAME.arg, symbol: venueSymbol },
    ts,
    data: [{ ...CAPTURED_TICKER_ROW, ...over }],
  }
}

// Registry: venue id → canonical, folding the 1000-multiplier like the real adapter.
const VENUE_TO_CANONICAL: Record<string, string> = { BTCUSDT: 'BTC', '1000PEPEUSDT': 'PEPE' }
const CANONICAL_TO_VENUE: Record<string, string> = { BTC: 'BTCUSDT', PEPE: '1000PEPEUSDT' }
const resolveAny = (venue: string): string | undefined => VENUE_TO_CANONICAL[venue]
const now = (): number => 777

describe('pure mappers', () => {
  it('maps the captured live frame — both signals off one payload, real values, no rescaling loss', () => {
    // -0.000008 (decimal fraction) → -0.0008 % ; `·100` is binary-float, hence toBeCloseTo.
    const funding = tickerToFundingPredicted(CAPTURED_TICKER_FRAME, resolveAny, now)
    expect(funding).toMatchObject({ type: 'FundingPredicted', symbol: 'BTC', ts: 1_700_000_000_000 })
    expect(funding?.rate).toBeCloseTo(-0.0008, 12)
    expect(tickerToMarketTick(CAPTURED_TICKER_FRAME, resolveAny, now)).toEqual({
      type: 'MarketTick',
      symbol: 'BTC',
      price: 64_607.1,
      ts: 1_700_000_000_000,
    })
  })

  it('maps a funding decimal → signed percent, ts from the frame', () => {
    expect(tickerToFundingPredicted(frame('BTCUSDT', { fundingRate: '0.0001' }, 42), resolveAny, now)).toEqual({
      type: 'FundingPredicted',
      symbol: 'BTC',
      rate: 0.01,
      ts: 42,
    })
  })

  it('folds a multiplier symbol via the resolver', () => {
    expect(tickerToFundingPredicted(frame('1000PEPEUSDT', { fundingRate: '-0.0005' }), resolveAny, now)).toMatchObject({
      symbol: 'PEPE',
      rate: -0.05,
    })
  })

  it('maps lastPrice → MarketTick', () => {
    expect(tickerToMarketTick(frame('BTCUSDT', { lastPrice: '60050.5' }, 99), resolveAny, now)).toEqual({
      type: 'MarketTick',
      symbol: 'BTC',
      price: 60_050.5,
      ts: 99,
    })
  })

  it('publishes nothing for the blank "" Bitget writes for "no value" (never a zero rate or price)', () => {
    // Number('') === 0, which would look like a real 0 % rate / a free instrument downstream.
    expect(tickerToFundingPredicted(frame('BTCUSDT', { fundingRate: '' }), resolveAny, now)).toBeNull()
    expect(tickerToMarketTick(frame('BTCUSDT', { lastPrice: '' }), resolveAny, now)).toBeNull()
  })

  it('publishes nothing when the field is absent altogether', () => {
    const bare = { arg: { instType: WS_INST_TYPE, symbol: 'BTCUSDT', topic: 'ticker' }, data: [{}], ts: 1 }
    expect(tickerToFundingPredicted(bare, resolveAny, now)).toBeNull()
    expect(tickerToMarketTick(bare, resolveAny, now)).toBeNull()
  })

  it('reads the instrument off arg.symbol — the data row never carries it', () => {
    // Same row, no arg.symbol: nothing to resolve, so nothing is published.
    const anonymous = { arg: { instType: WS_INST_TYPE, topic: 'ticker' }, data: [CAPTURED_TICKER_ROW], ts: 5 }
    expect(tickerToFundingPredicted(anonymous, resolveAny, now)).toBeNull()
    expect(tickerToMarketTick(anonymous, resolveAny, now)).toBeNull()
  })

  it('falls back to the clock when the frame carries no ts', () => {
    const noTs = { arg: { instType: WS_INST_TYPE, symbol: 'BTCUSDT', topic: 'ticker' }, data: [{ lastPrice: '1' }] }
    expect(tickerToMarketTick(noTs, resolveAny, now)).toMatchObject({ ts: 777 })
  })

  it('returns null for an unknown symbol', () => {
    expect(tickerToFundingPredicted(frame('DOGEUSDT', { fundingRate: '0.001' }), resolveAny, now)).toBeNull()
    expect(tickerToMarketTick(frame('DOGEUSDT', { lastPrice: '1' }), resolveAny, now)).toBeNull()
  })
})

// ── Wired-stream harness (fake ws emitter + fake bus) ─────────────────────────

interface FakeWs extends BitgetWsClient {
  emit(event: string, arg: unknown): void
  subscribed: BitgetTopicRequest[][]
  unsubscribed: BitgetTopicRequest[][]
  wsKeys: string[]
  closed: number
}

function makeFakeWs(): FakeWs {
  const listeners = new Map<string, (arg: unknown) => void>()
  return {
    subscribed: [],
    unsubscribed: [],
    wsKeys: [],
    closed: 0,
    subscribe(requests, wsKey) {
      this.subscribed.push(requests)
      this.wsKeys.push(wsKey)
      return Promise.resolve()
    },
    unsubscribe(requests, wsKey) {
      this.unsubscribed.push(requests)
      this.wsKeys.push(wsKey)
      return Promise.resolve()
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
  const stream = createBitgetPublicStream({
    ws,
    bus,
    clock,
    wsKey: WS_KEY,
    resolveCanonical: resolveAny,
    resolveVenue: (symbol) => CANONICAL_TO_VENUE[symbol] ?? symbol,
    restFundingAll,
    restTicker,
  })
  return { clock, ws, bus, events, stream }
}

describe('createBitgetPublicStream — live WS flow', () => {
  it('subscribe wires one ticker topic per symbol, in one batch, on the public wsKey', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC', 'PEPE'])
    // The v3 lib takes the whole batch plus a connection key (unlike OKX's per-request array).
    expect(ws.subscribed).toEqual([[tickerSub('BTCUSDT'), tickerSub('1000PEPEUSDT')]])
    expect(ws.wsKeys).toEqual([WS_KEY])
  })

  it('one frame publishes both FundingPredicted and MarketTick — the topics are fused', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])
    ws.emit('update', frame('BTCUSDT', { fundingRate: '0.0003', lastPrice: '60100' }, 10))
    expect(events).toEqual([
      { type: 'FundingPredicted', symbol: 'BTC', rate: 0.03, ts: 10 },
      { type: 'MarketTick', symbol: 'BTC', price: 60_100, ts: 10 },
    ])
  })

  it('gates funding to the subscribed universe (registry-known but unsubscribed symbol is dropped)', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC']) // PEPE resolves in the registry but is not subscribed
    ws.emit('update', frame('1000PEPEUSDT', { fundingRate: '0.0002' }))
    expect(events).toEqual([])
  })

  it('gates ticks to the shortlist — a funding-only symbol publishes no MarketTick', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC']) // funding universe only, no subscribeTicks
    ws.emit('update', frame('BTCUSDT', { fundingRate: '0.0001', lastPrice: '60000' }, 7))
    expect(events).toEqual([{ type: 'FundingPredicted', symbol: 'BTC', rate: 0.01, ts: 7 }])
  })

  it('a frame for a symbol in neither set publishes nothing at all', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    ws.emit('update', frame('DOGEUSDT', { fundingRate: '0.001', lastPrice: '1' })) // not in the registry
    expect(events).toEqual([])
  })

  it('reference-counts the shared topic: subscribeTicks on a funding symbol adds no subscription', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])
    // The topic is already live for funding; only the local tick gate changed.
    expect(ws.subscribed).toEqual([[tickerSub('BTCUSDT')]])
  })

  it('unsubscribeTicks keeps the topic while funding still needs it, drops it otherwise', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC']) // BTC also in the funding universe
    await stream.subscribeTicks(['BTC', 'PEPE']) // PEPE is tick-only
    await stream.unsubscribeTicks(['BTC', 'PEPE'])
    expect(ws.subscribed).toEqual([[tickerSub('BTCUSDT')], [tickerSub('1000PEPEUSDT')]])
    // Only the tick-only symbol is dropped — dropping BTC would blind the funding universe.
    expect(ws.unsubscribed).toEqual([[tickerSub('1000PEPEUSDT')]])
  })

  it('funding keeps flowing for a symbol whose ticks were just unsubscribed', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])
    await stream.unsubscribeTicks(['BTC'])
    ws.emit('update', frame('BTCUSDT', { fundingRate: '0.0004', lastPrice: '60100' }, 12))
    expect(events).toEqual([{ type: 'FundingPredicted', symbol: 'BTC', rate: 0.04, ts: 12 }])
  })

  it('a re-declared universe diffs: subscribes the additions, drops the symbols that left', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribe(['PEPE']) // BTC leaves, PEPE joins
    expect(ws.subscribed).toEqual([[tickerSub('BTCUSDT')], [tickerSub('1000PEPEUSDT')]])
    expect(ws.unsubscribed).toEqual([[tickerSub('BTCUSDT')]])
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
    const dup = frame('BTCUSDT', { fundingRate: '0.0001' }, 5)
    expect(() => {
      ws.emit('update', dup)
      ws.emit('update', dup)
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
    expect(() => ws.emit('update', { arg: { topic: 'books15', symbol: 'BTCUSDT' }, data: [] })).not.toThrow()
    expect(() => ws.emit('update', { arg: { topic: 'ticker', symbol: 'BTCUSDT' } })).not.toThrow() // no data array
    expect(() => ws.emit('update', { event: 'subscribe', arg: { topic: 'ticker' } })).not.toThrow()
  })

  it('close() closes the socket', async () => {
    const { ws, stream } = build()
    await stream.close()
    expect(ws.closed).toBe(1)
  })
})

describe('createBitgetPublicStream — disconnect / fallback / reprime', () => {
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

  it('the fallback also covers the tick shortlist, per subscribed symbol', async () => {
    const restTicker = vi.fn((_symbol: string) => Promise.resolve({ price: 61_000, ts: 700 }))
    const { ws, events, stream } = build({ restTicker })
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])

    ws.emit('reconnect', {})
    await flush()

    expect(restTicker).toHaveBeenCalledWith('BTC') // canonical: the adapter's REST read resolves it
    expect(events).toContainEqual({ type: 'MarketTick', symbol: 'BTC', price: 61_000, ts: 700 })
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
