import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../src/adapters/clock/virtual-clock.js'
import { createReconnectController, expBackoff } from '../../../../src/adapters/shared/reconnect.js'

describe('expBackoff', () => {
  it('doubles from base and caps', () => {
    const seq = [0, 1, 2, 3, 4, 5].map((a) => expBackoff(a, 1_000, 30_000))
    expect(seq).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) // 32_000 clamped to 30_000
  })
})

describe('createReconnectController', () => {
  it('starts live and no-ops markReconnected when already live', () => {
    const clock = createVirtualClock(0)
    const controller = createReconnectController({
      clock,
      onEnterDegraded: () => () => {},
      onReprime: () => Promise.resolve(),
    })
    expect(controller.state).toBe('live')
    controller.markReconnected() // spurious — ignored
    expect(controller.state).toBe('live')
  })

  it('degrades on disconnect (starting fallback) and recovers via reprime-before-resume', async () => {
    const clock = createVirtualClock(0)
    const order: string[] = []
    let stopped = false
    const controller = createReconnectController({
      clock,
      onEnterDegraded: () => {
        order.push('fallback-start')
        return () => {
          stopped = true
          order.push('fallback-stop')
        }
      },
      onReprime: () => {
        order.push('reprime')
        return Promise.resolve()
      },
    })

    controller.markDisconnected()
    expect(controller.state).toBe('degraded')
    expect(order).toEqual(['fallback-start'])

    controller.markReconnected()
    expect(controller.state).toBe('repriming') // fallback still running until reprime lands
    await Promise.resolve() // let onReprime resolve
    await Promise.resolve()

    expect(controller.state).toBe('live')
    expect(stopped).toBe(true)
    // Ordering: reprime must complete BEFORE the fallback stops and we resume live.
    expect(order).toEqual(['fallback-start', 'reprime', 'fallback-stop'])
  })

  it('is idempotent on repeated disconnects — one fallback only', () => {
    const clock = createVirtualClock(0)
    let starts = 0
    const controller = createReconnectController({
      clock,
      onEnterDegraded: () => {
        starts += 1
        return () => {}
      },
      onReprime: () => Promise.resolve(),
    })
    controller.markDisconnected()
    controller.markDisconnected()
    controller.markDisconnected()
    expect(starts).toBe(1)
  })

  it('backs off and retries reprime on failure, then resumes', async () => {
    const clock = createVirtualClock(0)
    let attempts = 0
    let stopped = false
    const backoffCalls: number[] = []
    const controller = createReconnectController({
      clock,
      onEnterDegraded: () => () => {
        stopped = true
      },
      onReprime: () => {
        attempts += 1
        if (attempts < 3) return Promise.reject(new Error('reprime failed'))
        return Promise.resolve()
      },
      backoff: (attempt) => {
        backoffCalls.push(attempt)
        return 1_000
      },
    })

    controller.markDisconnected()
    controller.markReconnected()
    await Promise.resolve() // first reprime attempt rejects → schedule retry
    await Promise.resolve()
    expect(controller.state).toBe('repriming')
    expect(attempts).toBe(1)

    clock.advanceBy(1_000) // fire retry #1 (attempt still fails)
    await Promise.resolve()
    await Promise.resolve()
    expect(attempts).toBe(2)

    clock.advanceBy(1_000) // fire retry #2 (succeeds)
    await Promise.resolve()
    await Promise.resolve()
    expect(attempts).toBe(3)
    expect(controller.state).toBe('live')
    expect(stopped).toBe(true)
    expect(backoffCalls).toEqual([0, 1]) // 0-based attempt index per retry
  })
})
