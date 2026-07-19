import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../src/adapters/clock/virtual-clock.js'
import { createEventBus } from '../../../../src/core/events/bus.js'
import type { EngineEvent, Timer } from '../../../../src/core/events/types.js'
import { createScheduler } from '../../../../src/core/runtime/scheduler.js'

const MIN = 60_000
const HOUR = 3_600_000
// Hour-aligned epoch ms standing in for "10:00:00 UTC"; only the minute-within-hour
// matters to the scan boundary, so any multiple of HOUR represents a top-of-hour.
const H10 = 10 * HOUR
const at = (min: number, sec = 0): number => H10 + min * MIN + sec * 1_000

const timers = (events: EngineEvent[]): Timer[] => events.filter((e): e is Timer => e.type === 'Timer')

describe('createScheduler', () => {
  it('fires exactly one scan Timer at HH:58:00 advancing 10:57 → 11:00', () => {
    const clock = createVirtualClock(at(57)) // 10:57:00
    const bus = createEventBus()
    const received: EngineEvent[] = []
    bus.subscribe((e) => received.push(e))

    const scheduler = createScheduler(clock, bus)
    scheduler.start()
    clock.advanceTo(at(60)) // 11:00:00

    const scans = timers(received).filter((t) => t.kind === 'scan')
    expect(scans).toEqual([{ type: 'Timer', kind: 'scan', ts: at(58) }])
  })

  it('fires an entry timer at T_settle − entryOffsetSeconds with the symbol', () => {
    const clock = createVirtualClock(at(57))
    const bus = createEventBus()
    const received: EngineEvent[] = []
    bus.subscribe((e) => received.push(e))

    const scheduler = createScheduler(clock, bus)
    const tSettle = at(60) // 11:00:00
    const entryAt = tSettle - 3 * 1_000 // offset 3s → 10:59:57
    scheduler.scheduleEntryTimer('BTCUSDT', entryAt)

    clock.advanceTo(at(60))

    const entries = timers(received).filter((t) => t.kind === 'entry')
    expect(entries).toEqual([{ type: 'Timer', kind: 'entry', ts: at(59, 57), symbol: 'BTCUSDT' }])
  })

  it('does not publish a deadline timer cancelled before it is due', () => {
    const clock = createVirtualClock(at(57))
    const bus = createEventBus()
    const received: EngineEvent[] = []
    bus.subscribe((e) => received.push(e))

    const scheduler = createScheduler(clock, bus)
    const handle = scheduler.scheduleDeadlineTimer('intent-1', at(59))
    handle.cancel()

    clock.advanceTo(at(60))

    expect(timers(received).filter((t) => t.kind === 'deadline')).toEqual([])
  })

  it('reschedules the scan for the following hour (self-perpetuating)', () => {
    const clock = createVirtualClock(at(57))
    const bus = createEventBus()
    const received: EngineEvent[] = []
    bus.subscribe((e) => received.push(e))

    const scheduler = createScheduler(clock, bus)
    scheduler.start()
    clock.advanceTo(at(120)) // 12:00:00 — spans two HH:58 boundaries

    const scans = timers(received).filter((t) => t.kind === 'scan')
    expect(scans.map((t) => t.ts)).toEqual([at(58), at(58) + HOUR]) // 10:58, 11:58
  })

  it('stop() cancels the scan timer so no further scans fire', () => {
    const clock = createVirtualClock(at(57))
    const bus = createEventBus()
    const received: EngineEvent[] = []
    bus.subscribe((e) => received.push(e))

    const scheduler = createScheduler(clock, bus)
    scheduler.start()
    scheduler.stop()

    clock.advanceTo(at(120))
    expect(timers(received).filter((t) => t.kind === 'scan')).toEqual([])
  })
})
