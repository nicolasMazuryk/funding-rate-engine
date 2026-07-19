import { describe, expect, it } from 'vitest'
import { createEventBus } from '../../../../src/core/events/bus.js'
import type { EngineEvent, MarketTick } from '../../../../src/core/events/types.js'

const tick = (symbol: string, price: number, ts: number): MarketTick => ({
  type: 'MarketTick',
  symbol,
  price,
  ts,
})

describe('createEventBus', () => {
  it('delivers events to a subscriber in publish order per symbol, with interleaved symbols', () => {
    const bus = createEventBus()
    const received: EngineEvent[] = []
    bus.subscribe((e) => received.push(e))

    // Interleave two symbols; each symbol's ticks are published in ascending ts.
    const seq: MarketTick[] = [
      tick('BTC', 1, 100),
      tick('ETH', 10, 101),
      tick('BTC', 2, 102),
      tick('ETH', 11, 103),
      tick('BTC', 3, 104),
    ]
    for (const e of seq) bus.publish(e)

    // Global order preserved (subsumes per-symbol FIFO).
    expect(received).toEqual(seq)

    // Per-symbol projection is FIFO.
    const btc = received.filter((e) => e.type === 'MarketTick' && e.symbol === 'BTC')
    const eth = received.filter((e) => e.type === 'MarketTick' && e.symbol === 'ETH')
    expect(btc.map((e) => (e as MarketTick).price)).toEqual([1, 2, 3])
    expect(eth.map((e) => (e as MarketTick).price)).toEqual([10, 11])
  })

  it('delivers each event to every subscriber', () => {
    const bus = createEventBus()
    const a: EngineEvent[] = []
    const b: EngineEvent[] = []
    bus.subscribe((e) => a.push(e))
    bus.subscribe((e) => b.push(e))

    const e = tick('BTC', 42, 200)
    bus.publish(e)

    expect(a).toEqual([e])
    expect(b).toEqual([e])
  })

  it('preserves FIFO order under re-entrant publish (queue-drain, not depth-first)', () => {
    const bus = createEventBus()
    // Two handlers, tuples record (price, handler). With queue-drain FIFO, event 1
    // finishes fanning out to BOTH handlers before the re-entrant 99 is dispatched.
    // Depth-first (recursive) dispatch would instead deliver 99 to both handlers
    // in the middle of event 1's fan-out — i.e. before `1@B`.
    const log: string[] = []
    let reentered = false
    bus.subscribe((e) => {
      if (e.type === 'MarketTick') {
        log.push(`${e.price}@A`)
        if (e.price === 1 && !reentered) {
          reentered = true
          bus.publish(tick('BTC', 99, 999)) // enqueued at the tail, not dispatched now
        }
      }
    })
    bus.subscribe((e) => {
      if (e.type === 'MarketTick') log.push(`${e.price}@B`)
    })

    bus.publish(tick('BTC', 1, 100))

    expect(log).toEqual(['1@A', '1@B', '99@A', '99@B'])
  })

  it('unsubscribe stops delivery and is idempotent', () => {
    const bus = createEventBus()
    const received: EngineEvent[] = []
    const off = bus.subscribe((e) => received.push(e))

    bus.publish(tick('BTC', 1, 100))
    off()
    off() // idempotent
    bus.publish(tick('BTC', 2, 101))

    expect(received).toHaveLength(1)
  })
})
