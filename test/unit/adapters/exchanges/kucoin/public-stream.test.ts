/**
 * Unit: KuCoin public market-data stream (`10` §7). Offline against a fake `WebsocketClient`
 * emitter + fake bus, on the virtual clock, driving the **real captured frames**
 * (`./ws-fixtures.ts` → `test/fixtures/kucoin/public-ws/frames.jsonl`) rather than hand-typed
 * approximations of them. Focus on the venue quirks that shape the file:
 *  - **two channels, OKX's shape, not Bybit's fused one**: `/contract/instrument` carries funding
 *    and `/contractMarket/ticker` carries the last traded price, so nothing is shared and no
 *    reference count is needed;
 *  - **one topic, two subjects**: `/contract/instrument` also multiplexes `mark.index.price`, and
 *    a mark price is *not* a last price — feeding one into `MarketTick` would silently mis-price
 *    every entry and exit, so that subject must publish nothing at all;
 *  - **the ticker `ts` is in NANOSECONDS** (`1785092660747000000`). Used raw it lands ~56 000
 *    years out and every freshness gate (`00_globals.md` §7) reads permanently fresh, which is the
 *    one real trap on this venue. The funding frame's `timestamp` is ordinary epoch ms, so the two
 *    fields in the same capture disagree by 1e6 and only one of them may be scaled;
 *  - **the symbol lives on the topic suffix**, never on the funding row, so an unresolvable
 *    instrument is dropped rather than guessed from the subscribed set;
 *  - **there is no bulk funding read on this venue** (`has.fetchFundingRates === false`), so the
 *    degraded-mode fallback is a per-symbol fan-out — asserted as one `restFunding` call per
 *    subscribed symbol, where all four siblings spend a single bulk call.
 */

import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import {
  createKucoinPublicStream,
  frameSymbol,
  fundingFrameToFundingPredicted,
  type KucoinFundingRateData,
  type KucoinPublicFrame,
  type KucoinTickerData,
  type KucoinWsClient,
  type TickerReading,
  tickerFrameToMarketTick,
} from '../../../../../src/adapters/exchanges/kucoin/public-stream.js'
import type { EngineEvent } from '../../../../../src/core/events/types.js'
import type { EventBus } from '../../../../../src/core/ports/bus.js'
import type { Rate } from '../../../../../src/core/ports/exchange-adapter.js'
import {
  CAPTURED_FUNDING_FRAME,
  CAPTURED_MARK_INDEX_FRAME,
  CAPTURED_TICKER_FRAME,
  INSTRUMENT_TOPIC,
  TICKER_TOPIC,
} from './ws-fixtures.js'

/** The lib's connection key for the public futures socket, as the factory passes it. */
const WS_KEY = 'futuresPublicV1'

/** Registry: venue id → canonical. `XBT` → `BTC` is ccxt's own mapping, not ours. */
const VENUE_TO_CANONICAL: Record<string, string> = { XBTUSDTM: 'BTC', '1000BONKUSDTM': 'BONK' }
const CANONICAL_TO_VENUE: Record<string, string> = { BTC: 'XBTUSDTM', BONK: '1000BONKUSDTM' }
const resolveAny = (venue: string): string | undefined => VENUE_TO_CANONICAL[venue]
const now = (): number => 777

/** A `funding.rate` frame in the venue's envelope, defaults taken from the **captured** frame. */
function fundingFrame(
  venueSymbol: string,
  over: Partial<KucoinFundingRateData> = {},
): KucoinPublicFrame<KucoinFundingRateData> {
  return {
    ...CAPTURED_FUNDING_FRAME,
    topic: `${INSTRUMENT_TOPIC}:${venueSymbol}`,
    data: { ...CAPTURED_FUNDING_FRAME.data, ...over },
  }
}

/** A `ticker` frame in the venue's envelope, defaults taken from the **captured** frame. */
function tickerFrame(venueSymbol: string, over: Partial<KucoinTickerData> = {}): KucoinPublicFrame<KucoinTickerData> {
  return {
    ...CAPTURED_TICKER_FRAME,
    topic: `${TICKER_TOPIC}:${venueSymbol}`,
    data: { ...CAPTURED_TICKER_FRAME.data, symbol: venueSymbol, ...over },
  }
}

describe('pure mappers — the captured frames', () => {
  it('maps the captured funding push to signed percent off its epoch-ms timestamp', () => {
    // -0.000007 (decimal fraction) → -0.0007 % ; the `timestamp` field is already epoch ms.
    expect(fundingFrameToFundingPredicted(CAPTURED_FUNDING_FRAME, resolveAny, now)).toEqual({
      type: 'FundingPredicted',
      symbol: 'BTC',
      rate: -0.0007,
      ts: 1_700_000_000_000,
    })
  })

  it('maps the captured ticker push, converting its NANOSECOND ts to epoch ms', () => {
    // The trap: `1785092660747000000` used raw is ~56 000 years out and reads permanently fresh.
    expect(CAPTURED_TICKER_FRAME.data?.ts).toBe(1_785_092_660_747_000_000)
    expect(tickerFrameToMarketTick(CAPTURED_TICKER_FRAME, resolveAny, now)).toEqual({
      type: 'MarketTick',
      symbol: 'BTC',
      price: 64_706.1,
      ts: 1_785_092_660_747,
    })
  })

  it('scales the ticker ts and NOT the funding timestamp — the two fields differ by 1e6', () => {
    const tick = tickerFrameToMarketTick(CAPTURED_TICKER_FRAME, resolveAny, now)
    const funding = fundingFrameToFundingPredicted(CAPTURED_FUNDING_FRAME, resolveAny, now)
    // Both land in the same century; scaling the funding one too would put it in 1970.
    expect(tick?.ts).toBeGreaterThan(1_600_000_000_000)
    expect(funding?.ts).toBeGreaterThan(1_600_000_000_000)
  })

  it('reads the instrument off the topic suffix — the funding row never carries a symbol', () => {
    expect(CAPTURED_FUNDING_FRAME.data).not.toHaveProperty('symbol')
    expect(frameSymbol(CAPTURED_FUNDING_FRAME)).toBe('XBTUSDTM')
    // No suffix ⇒ nothing to resolve ⇒ nothing published (never guessed from the subscribed set).
    expect(frameSymbol({ topic: INSTRUMENT_TOPIC })).toBeUndefined()
    expect(
      fundingFrameToFundingPredicted({ ...CAPTURED_FUNDING_FRAME, topic: INSTRUMENT_TOPIC }, resolveAny, now),
    ).toBeNull()
  })

  it('folds a multiplier symbol via the resolver', () => {
    expect(
      fundingFrameToFundingPredicted(fundingFrame('1000BONKUSDTM', { fundingRate: -0.0005 }), resolveAny, now),
    ).toMatchObject({ symbol: 'BONK', rate: -0.05 })
  })

  it('publishes nothing for a blank or absent field (never a zero rate or price)', () => {
    // Number('') === 0, which would look like a real 0 % rate / a free instrument downstream.
    expect(
      fundingFrameToFundingPredicted(fundingFrame('XBTUSDTM', { fundingRate: undefined }), resolveAny, now),
    ).toBeNull()
    expect(tickerFrameToMarketTick(tickerFrame('XBTUSDTM', { price: '' }), resolveAny, now)).toBeNull()
    expect(tickerFrameToMarketTick(tickerFrame('XBTUSDTM', { price: undefined }), resolveAny, now)).toBeNull()
  })

  it('falls back to the clock when the frame carries no timestamp of its own', () => {
    expect(
      fundingFrameToFundingPredicted(fundingFrame('XBTUSDTM', { timestamp: undefined }), resolveAny, now),
    ).toMatchObject({ ts: 777 })
    expect(tickerFrameToMarketTick(tickerFrame('XBTUSDTM', { ts: undefined }), resolveAny, now)).toMatchObject({
      ts: 777,
    })
  })

  it('returns null for an unknown symbol', () => {
    expect(fundingFrameToFundingPredicted(fundingFrame('DOGEUSDTM'), resolveAny, now)).toBeNull()
    expect(tickerFrameToMarketTick(tickerFrame('DOGEUSDTM'), resolveAny, now)).toBeNull()
  })
})

// ── Wired-stream harness (fake ws emitter + fake bus) ─────────────────────────

interface FakeWs extends KucoinWsClient {
  emit(event: string, arg: unknown): void
  subscribed: string[][]
  unsubscribed: string[][]
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
    subscribe(topics, wsKey) {
      // Synchronous on this SDK: it returns void, not a promise (the lib owns the bullet token).
      this.subscribed.push(typeof topics === 'string' ? [topics] : topics)
      this.wsKeys.push(wsKey)
    },
    unsubscribe(topics, wsKey) {
      this.unsubscribed.push(typeof topics === 'string' ? [topics] : topics)
      this.wsKeys.push(wsKey)
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
  const restTicker = overrides?.restTicker ?? ((_symbol: string) => Promise.resolve({ price: 64_700, ts: 700 }))
  const stream = createKucoinPublicStream({
    ws,
    bus,
    clock,
    wsKey: WS_KEY,
    resolveCanonical: resolveAny,
    resolveVenue: (symbol) => CANONICAL_TO_VENUE[symbol] ?? symbol,
    restFunding,
    restTicker,
  })
  return { clock, ws, bus, events, stream }
}

describe('createKucoinPublicStream — live WS flow', () => {
  it('subscribes the instrument topic per funding symbol and the ticker topic per tick symbol', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC', 'BONK'])
    await stream.subscribeTicks(['BTC'])
    expect(ws.subscribed).toEqual([
      [`${INSTRUMENT_TOPIC}:XBTUSDTM`, `${INSTRUMENT_TOPIC}:1000BONKUSDTM`],
      [`${TICKER_TOPIC}:XBTUSDTM`],
    ])
    expect(ws.wsKeys).toEqual([WS_KEY, WS_KEY])
  })

  it('a funding.rate frame publishes FundingPredicted in signed percent', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    ws.emit('update', fundingFrame('XBTUSDTM', { fundingRate: 0.0003, timestamp: 10 }))
    expect(events).toEqual([{ type: 'FundingPredicted', symbol: 'BTC', rate: 0.03, ts: 10 }])
  })

  it('a ticker frame publishes MarketTick with its nanosecond ts converted', async () => {
    const { ws, events, stream } = build()
    await stream.subscribeTicks(['BTC'])
    ws.emit('update', CAPTURED_TICKER_FRAME)
    expect(events).toEqual([{ type: 'MarketTick', symbol: 'BTC', price: 64_706.1, ts: 1_785_092_660_747 }])
  })

  it('publishes NOTHING for mark.index.price — a mark price is not the last traded price', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])
    // Same topic as the funding frame, different subject, and a real `markPrice` on the row: the
    // subject is part of the type guard precisely so this cannot become a MarketTick.
    expect(CAPTURED_MARK_INDEX_FRAME.data?.markPrice).toBeGreaterThan(0)
    ws.emit('update', CAPTURED_MARK_INDEX_FRAME)
    expect(events).toEqual([])
  })

  it('drops a frame whose symbol does not resolve, on either channel', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])
    ws.emit('update', fundingFrame('DOGEUSDTM', { fundingRate: 0.001 })) // not in the registry
    ws.emit('update', tickerFrame('DOGEUSDTM', { price: '1' }))
    expect(events).toEqual([])
  })

  it('gates each channel to its own subscribed set', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC']) // funding universe only — no subscribeTicks
    ws.emit('update', fundingFrame('1000BONKUSDTM', { fundingRate: 0.0002 })) // registry-known, unsubscribed
    ws.emit('update', tickerFrame('XBTUSDTM', { price: '64000' })) // not on the tick shortlist
    expect(events).toEqual([])
  })

  it('a re-declared universe diffs: subscribes the additions, drops the symbols that left', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribe(['BONK']) // BTC leaves, BONK joins
    expect(ws.subscribed).toEqual([[`${INSTRUMENT_TOPIC}:XBTUSDTM`], [`${INSTRUMENT_TOPIC}:1000BONKUSDTM`]])
    expect(ws.unsubscribed).toEqual([[`${INSTRUMENT_TOPIC}:XBTUSDTM`]])
  })

  it('unsubscribeTicks always drops the ticker topic — nothing else is using it', async () => {
    // The Bitget/Bybit reference count has no analogue here: the two channels are disjoint, so a
    // dropped ticker topic can never blind the funding universe.
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])
    await stream.unsubscribeTicks(['BTC'])
    expect(ws.unsubscribed).toEqual([[`${TICKER_TOPIC}:XBTUSDTM`]])
    ws.emit('update', fundingFrame('XBTUSDTM', { fundingRate: 0.0004, timestamp: 12 }))
    expect(events).toEqual([{ type: 'FundingPredicted', symbol: 'BTC', rate: 0.04, ts: 12 }])
  })

  it('never throws into the socket lib on a malformed frame', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    expect(() => ws.emit('update', undefined)).not.toThrow()
    expect(() => ws.emit('update', { topic: `${INSTRUMENT_TOPIC}:XBTUSDTM`, subject: 'funding.rate' })).not.toThrow()
    expect(() => ws.emit('update', { topic: '/contractMarket/level2:XBTUSDTM', data: {} })).not.toThrow()
    expect(() => ws.emit('update', { type: 'ack', id: '1' })).not.toThrow()
  })

  it('close() closes the socket', async () => {
    const { ws, stream } = build()
    await stream.close()
    expect(ws.closed).toBe(1)
  })
})

describe('createKucoinPublicStream — disconnect / fallback / reprime', () => {
  it('the degraded fallback is a PER-SYMBOL fan-out — one restFunding call per subscribed symbol', async () => {
    // The KuCoin divergence: `has.fetchFundingRates === false`, so there is no bulk read to spend
    // once. A regression that reintroduced a bulk call would show up here as one call, not two.
    const restFunding = vi.fn((symbol: string) => Promise.resolve({ symbol, rate: 0.02, ts: 500 }))
    const { ws, events, stream } = build({ restFunding })
    await stream.subscribe(['BTC', 'BONK'])

    ws.emit('reconnect', {})
    await flush()

    expect(restFunding).toHaveBeenCalledTimes(2)
    expect(restFunding.mock.calls.map(([s]) => s)).toEqual(['BTC', 'BONK']) // canonical, one each
    expect(events).toEqual([
      { type: 'FundingPredicted', symbol: 'BTC', rate: 0.02, ts: 500 },
      { type: 'FundingPredicted', symbol: 'BONK', rate: 0.02, ts: 500 },
    ])
  })

  it('polls REST while degraded and stops on recover, repriming before resume', async () => {
    const restFunding = vi.fn((symbol: string) => Promise.resolve({ symbol, rate: 0.02, ts: 500 }))
    const { clock, ws, stream } = build({ restFunding })
    await stream.subscribe(['BTC'])

    ws.emit('reconnect', {})
    await flush()
    expect(restFunding).toHaveBeenCalledTimes(1)

    // The poll self-reschedules on the virtual clock while still degraded.
    clock.advanceBy(15_000)
    await flush()
    expect(restFunding).toHaveBeenCalledTimes(2)

    // Reconnect → reprime (one more REST snapshot) BEFORE the fallback stops.
    ws.emit('reconnected', {})
    await flush()
    const reprimeCount = restFunding.mock.calls.length
    expect(reprimeCount).toBe(3)

    // Once live, the fallback poll no longer fires on further clock advances.
    clock.advanceBy(15_000 * 5)
    await flush()
    expect(restFunding).toHaveBeenCalledTimes(reprimeCount)
  })

  it('the fallback also covers the tick shortlist, per subscribed symbol', async () => {
    const restTicker = vi.fn((_symbol: string) => Promise.resolve({ price: 64_700, ts: 700 }))
    const { ws, events, stream } = build({ restTicker })
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])

    ws.emit('reconnect', {})
    await flush()

    expect(restTicker).toHaveBeenCalledWith('BTC') // canonical: the adapter's REST read resolves it
    expect(events).toContainEqual({ type: 'MarketTick', symbol: 'BTC', price: 64_700, ts: 700 })
  })
})

/** Drain the microtask + resolved-promise chain the REST poll schedules. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
