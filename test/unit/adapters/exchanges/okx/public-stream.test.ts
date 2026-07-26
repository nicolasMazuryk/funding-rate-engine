/**
 * Unit: OKX public market-data stream (`10` §7). Offline against a fake `WebsocketClient`
 * emitter + fake bus. Focus on the venue quirk that shapes the file: **OKX splits what Bybit
 * fuses** — `funding-rate` and `tickers` are two independent per-`instId` channels, so each
 * subscribed set owns its own channel and the Bybit sibling's shared-topic reference count
 * does not exist here. Plus the shared rule both venues need: OKX writes `""` for "no value"
 * and `Number('')` is `0`, so a blank field must publish nothing rather than a zero.
 */

import { describe, expect, it, vi } from 'vitest'
import { createVirtualClock } from '../../../../../src/adapters/clock/virtual-clock.js'
import {
  createOkxPublicStream,
  fundingRowToFundingPredicted,
  type OkxFundingRateRow,
  type OkxTickerRow,
  type OkxWsClient,
  type TickerReading,
  tickerRowToMarketTick,
} from '../../../../../src/adapters/exchanges/okx/public-stream.js'
import type { EngineEvent } from '../../../../../src/core/events/types.js'
import type { EventBus } from '../../../../../src/core/ports/bus.js'
import type { Rate } from '../../../../../src/core/ports/exchange-adapter.js'
import { CAPTURED_FUNDING_ROW } from './ws-fixtures.js'

/** A `funding-rate` row, defaults taken from the **captured** venue payload (`./ws-fixtures.ts`). */
function fundingRow(instId: string, over: Partial<OkxFundingRateRow> = {}): OkxFundingRateRow {
  return { ...CAPTURED_FUNDING_ROW, instId, ...over }
}

function tickerRow(instId: string, over: Partial<OkxTickerRow> = {}): OkxTickerRow {
  return { instId, last: '60100', ts: '2000', ...over }
}

// Registry: venue id → canonical, as the real adapter's reverse index resolves it.
const VENUE_TO_CANONICAL: Record<string, string> = { 'BTC-USDT-SWAP': 'BTC', 'XRP-USDT-SWAP': 'XRP' }
const CANONICAL_TO_VENUE: Record<string, string> = { BTC: 'BTC-USDT-SWAP', XRP: 'XRP-USDT-SWAP' }
const resolveAny = (venue: string): string | undefined => VENUE_TO_CANONICAL[venue]
const now = (): number => 777

describe('pure mappers', () => {
  it('maps a funding decimal → signed percent, ts from the row', () => {
    const event = fundingRowToFundingPredicted(
      fundingRow('BTC-USDT-SWAP', { fundingRate: '0.0001', ts: '42' }),
      resolveAny,
      now,
    )
    expect(event).toEqual({ type: 'FundingPredicted', symbol: 'BTC', rate: 0.01, ts: 42 })
  })

  it('maps the captured live row (a real 16-digit rate) without losing sign or scale', () => {
    const event = fundingRowToFundingPredicted(
      fundingRow('XRP-USDT-SWAP', { fundingRate: '-0.0000657453668047' }),
      resolveAny,
      now,
    )
    expect(event).toMatchObject({ symbol: 'XRP', rate: -0.00657453668047 })
  })

  it('publishes no FundingPredicted for the blank rate OKX writes as "" (never a zero rate)', () => {
    expect(fundingRowToFundingPredicted(fundingRow('BTC-USDT-SWAP', { fundingRate: '' }), resolveAny, now)).toBeNull()
    expect(fundingRowToFundingPredicted({ instId: 'BTC-USDT-SWAP', ts: '1' }, resolveAny, now)).toBeNull()
  })

  it('maps a ticker last → MarketTick', () => {
    expect(tickerRowToMarketTick(tickerRow('BTC-USDT-SWAP', { last: '60050.5', ts: '99' }), resolveAny, now)).toEqual({
      type: 'MarketTick',
      symbol: 'BTC',
      price: 60_050.5,
      ts: 99,
    })
  })

  it('publishes no MarketTick for a blank last (never a zero price)', () => {
    expect(tickerRowToMarketTick(tickerRow('BTC-USDT-SWAP', { last: '' }), resolveAny, now)).toBeNull()
  })

  it('falls back to the clock when the row carries no ts', () => {
    expect(tickerRowToMarketTick({ instId: 'BTC-USDT-SWAP', last: '1' }, resolveAny, now)).toMatchObject({ ts: 777 })
  })

  it('returns null for an unknown symbol', () => {
    expect(fundingRowToFundingPredicted(fundingRow('DOGE-USDT-SWAP'), resolveAny, now)).toBeNull()
    expect(tickerRowToMarketTick(tickerRow('DOGE-USDT-SWAP'), resolveAny, now)).toBeNull()
  })
})

// ── Wired-stream harness (fake ws emitter + fake bus) ─────────────────────────

interface FakeWs extends OkxWsClient {
  emit(event: string, arg: unknown): void
  subscribed: unknown[][]
  unsubscribed: unknown[][]
  closed: number
}

function makeFakeWs(): FakeWs {
  const listeners = new Map<string, (arg: unknown) => void>()
  const asArgs = (args: unknown): unknown[] => (Array.isArray(args) ? args : [args])
  return {
    subscribed: [],
    unsubscribed: [],
    closed: 0,
    subscribe(args) {
      this.subscribed.push(asArgs(args))
      return [Promise.resolve()]
    },
    unsubscribe(args) {
      this.unsubscribed.push(asArgs(args))
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

/** A `funding-rate` push frame in the venue's own envelope. */
function fundingFrame(instId: string, over: Partial<OkxFundingRateRow> = {}): unknown {
  return { arg: { channel: 'funding-rate', instId }, data: [fundingRow(instId, over)] }
}

/** A `tickers` push frame in the venue's own envelope. */
function tickerFrame(instId: string, over: Partial<OkxTickerRow> = {}): unknown {
  return { arg: { channel: 'tickers', instId }, data: [tickerRow(instId, over)] }
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
    (() => Promise.resolve(new Map([['BTC-USDT-SWAP', { symbol: 'BTC-USDT-SWAP', rate: 0.02, ts: 500 }]])))
  const restTicker = overrides?.restTicker ?? ((_symbol: string) => Promise.resolve({ price: 61_000, ts: 700 }))
  const stream = createOkxPublicStream({
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

describe('createOkxPublicStream — live WS flow', () => {
  it('subscribe wires one funding-rate channel per symbol (no all-symbol stream on this venue)', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC', 'XRP'])
    expect(ws.subscribed).toEqual([
      [
        { channel: 'funding-rate', instId: 'BTC-USDT-SWAP' },
        { channel: 'funding-rate', instId: 'XRP-USDT-SWAP' },
      ],
    ])
  })

  it('subscribeTicks wires the separate tickers channel — the two sets never share a topic', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])
    expect(ws.subscribed).toEqual([
      [{ channel: 'funding-rate', instId: 'BTC-USDT-SWAP' }],
      [{ channel: 'tickers', instId: 'BTC-USDT-SWAP' }],
    ])
  })

  it('unsubscribeTicks always drops the tickers channel (no refcount against funding)', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC']) // BTC is also in the funding universe
    await stream.subscribeTicks(['BTC'])
    await stream.unsubscribeTicks(['BTC'])
    expect(ws.unsubscribed).toEqual([[{ channel: 'tickers', instId: 'BTC-USDT-SWAP' }]])
  })

  it('each channel publishes only its own event kind', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribeTicks(['BTC'])
    ws.emit('update', fundingFrame('BTC-USDT-SWAP', { fundingRate: '0.0003', ts: '10' }))
    ws.emit('update', tickerFrame('BTC-USDT-SWAP', { last: '60100', ts: '11' }))
    expect(events).toEqual([
      { type: 'FundingPredicted', symbol: 'BTC', rate: 0.03, ts: 10 },
      { type: 'MarketTick', symbol: 'BTC', price: 60_100, ts: 11 },
    ])
  })

  it('gates funding to the subscribed universe (registry-known but unsubscribed symbol is dropped)', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    ws.emit('update', fundingFrame('XRP-USDT-SWAP', { fundingRate: '0.0002' }))
    expect(events).toEqual([])
  })

  it('gates ticks to the shortlist — a funding-only symbol publishes no MarketTick', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC']) // funding universe only, no subscribeTicks
    ws.emit('update', tickerFrame('BTC-USDT-SWAP'))
    expect(events).toEqual([])
  })

  it('a re-declared universe diffs: subscribes the additions, drops the symbols that left', async () => {
    const { ws, stream } = build()
    await stream.subscribe(['BTC'])
    await stream.subscribe(['XRP']) // BTC leaves, XRP joins
    expect(ws.subscribed).toEqual([
      [{ channel: 'funding-rate', instId: 'BTC-USDT-SWAP' }],
      [{ channel: 'funding-rate', instId: 'XRP-USDT-SWAP' }],
    ])
    expect(ws.unsubscribed).toEqual([[{ channel: 'funding-rate', instId: 'BTC-USDT-SWAP' }]])
  })

  it('tolerates duplicate frames — idempotent mapping, publishes each, never throws', async () => {
    const { ws, events, stream } = build()
    await stream.subscribe(['BTC'])
    const frame = fundingFrame('BTC-USDT-SWAP', { fundingRate: '0.0001', ts: '5' })
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
    expect(() => ws.emit('update', { arg: { channel: 'books' }, data: [] })).not.toThrow()
    expect(() => ws.emit('update', { arg: { channel: 'funding-rate' } })).not.toThrow()
    expect(() => ws.emit('update', { event: 'subscribe', arg: { channel: 'tickers' } })).not.toThrow()
  })

  it('close() closes the socket', async () => {
    const { ws, stream } = build()
    await stream.close()
    expect(ws.closed).toBe(1)
  })
})

describe('createOkxPublicStream — disconnect / fallback / reprime', () => {
  it('polls REST while degraded and stops on recover, reprime before resume', async () => {
    const restFundingAll = vi.fn(() =>
      Promise.resolve<ReadonlyMap<string, Rate>>(
        new Map([['BTC-USDT-SWAP', { symbol: 'BTC-USDT-SWAP', rate: 0.02, ts: 500 }]]),
      ),
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

  it('bulk poll gates each returned instId to the subscribed funding universe', async () => {
    const restFundingAll = () =>
      Promise.resolve<ReadonlyMap<string, Rate>>(
        new Map([
          ['BTC-USDT-SWAP', { symbol: 'BTC-USDT-SWAP', rate: 0.02, ts: 500 }],
          ['DOGE-USDT-SWAP', { symbol: 'DOGE-USDT-SWAP', rate: 0.09, ts: 500 }], // not in registry
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
