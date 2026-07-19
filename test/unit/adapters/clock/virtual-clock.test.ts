import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../src/adapters/clock/virtual-clock.js'

describe('createVirtualClock', () => {
  it('now() starts at the given time and advanceTo/advanceBy move it', () => {
    const clock = createVirtualClock(1_000)
    expect(clock.now()).toBe(1_000)
    clock.advanceBy(500)
    expect(clock.now()).toBe(1_500)
    clock.advanceTo(5_000)
    expect(clock.now()).toBe(5_000)
  })

  it('fires timers in (atMs, seq) order across a single jump, setting now() to each fire time', () => {
    const clock = createVirtualClock(0)
    const fired: Array<[label: string, at: number]> = []
    // Register out of order; equal atMs (200) must fire in registration (seq) order.
    clock.scheduleTimer(300, () => fired.push(['c', clock.now()]))
    clock.scheduleTimer(200, () => fired.push(['a', clock.now()]))
    clock.scheduleTimer(200, () => fired.push(['b', clock.now()]))
    clock.scheduleTimer(100, () => fired.push(['z', clock.now()]))

    clock.advanceTo(1_000)

    expect(fired).toEqual([
      ['z', 100],
      ['a', 200],
      ['b', 200],
      ['c', 300],
    ])
    expect(clock.now()).toBe(1_000)
  })

  it('fires a timer registered mid-fire within the same advance when it is due', () => {
    const clock = createVirtualClock(0)
    const fired: string[] = []
    clock.scheduleTimer(100, () => {
      fired.push('scan')
      // Handler schedules a nearer-future timer still within the advance window.
      clock.scheduleTimer(150, () => fired.push('entry'))
    })

    clock.advanceTo(200)

    expect(fired).toEqual(['scan', 'entry'])
    expect(clock.now()).toBe(200)
  })

  it('does not fire timers past the advance target', () => {
    const clock = createVirtualClock(0)
    const fired: string[] = []
    clock.scheduleTimer(100, () => fired.push('due'))
    clock.scheduleTimer(500, () => fired.push('later'))

    clock.advanceTo(200)
    expect(fired).toEqual(['due'])
    expect(clock.now()).toBe(200)

    clock.advanceTo(500)
    expect(fired).toEqual(['due', 'later'])
  })

  it('a cancelled timer never fires (cancel is idempotent)', () => {
    const clock = createVirtualClock(0)
    const fired: string[] = []
    const handle = clock.scheduleTimer(100, () => fired.push('nope'))
    clock.scheduleTimer(100, () => fired.push('yes'))

    handle.cancel()
    handle.cancel() // idempotent

    clock.advanceTo(1_000)
    expect(fired).toEqual(['yes'])
  })

  it('produces identical fire order on repeated identical runs (determinism)', () => {
    const run = (): string[] => {
      const clock = createVirtualClock(0)
      const fired: string[] = []
      clock.scheduleTimer(300, () => fired.push('c'))
      clock.scheduleTimer(100, () => fired.push('a'))
      clock.scheduleTimer(300, () => fired.push('d')) // ties broken by seq → after 'c'
      clock.scheduleTimer(200, () => fired.push('b'))
      clock.advanceTo(1_000)
      return fired
    }
    const first = run()
    const second = run()
    expect(first).toEqual(['a', 'b', 'c', 'd'])
    expect(second).toEqual(first)
  })
})
