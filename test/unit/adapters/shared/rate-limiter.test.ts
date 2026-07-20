import { describe, expect, it } from 'vitest'
import { createVirtualClock } from '../../../../src/adapters/clock/virtual-clock.js'
import { RateLimitedError } from '../../../../src/adapters/shared/errors.js'
import { budgetToLimiterArgs, createRateLimiter } from '../../../../src/adapters/shared/rate-limiter.js'

// capacity 100, 10% reserve → order lane 10, general lane 90. Full refill in 1000 ms
// (refillPerMs 0.1 → order 0.01/ms, general 0.09/ms).
const CAP = 100
const REFILL_PER_MS = 0.1
const RESERVE = 0.1

function makeLimiter(startMs = 0) {
  const clock = createVirtualClock(startMs)
  const limiter = createRateLimiter({ capacity: CAP, refillPerMs: REFILL_PER_MS, reserveFraction: RESERVE, clock })
  return { clock, limiter }
}

/** Let a resolved-promise chain settle without advancing virtual time. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe('createRateLimiter (10 §6, 00_globals §6)', () => {
  it('(a) a saturated general lane never blocks an order-lane acquire', async () => {
    const { limiter } = makeLimiter()
    await limiter.acquire(90, 'general') // drain the general lane fully
    // Order lane still has its 10 reserved tokens → admits with no delay.
    await expect(limiter.acquire(5, 'order')).resolves.toBeUndefined()
  })

  it('(b) an exhausted order lane throws RateLimited instead of queueing', async () => {
    const { limiter } = makeLimiter()
    await limiter.acquire(90, 'general') // general = 0, so no tokens to borrow
    await limiter.acquire(10, 'order') // drain the reserve
    expect(() => limiter.acquire(1, 'order')).toThrow(RateLimitedError)
  })

  it('(c) advancing virtual time refills capacity', async () => {
    const { clock, limiter } = makeLimiter()
    await limiter.acquire(90, 'general')
    await limiter.acquire(10, 'order')
    expect(() => limiter.acquire(1, 'order')).toThrow(RateLimitedError)

    clock.advanceBy(1000) // one full refill window → both lanes back to capacity
    await expect(limiter.acquire(10, 'order')).resolves.toBeUndefined()
  })

  it('(d) a weight-N general call consumes N tokens; the deficit delays until refill', async () => {
    const { clock, limiter } = makeLimiter()
    await limiter.acquire(90, 'general') // exact capacity — succeeds immediately
    let done = false
    const pending = limiter.acquire(9, 'general').then(() => {
      done = true
    })
    await flush()
    expect(done).toBe(false) // over budget → waits, does not resolve

    clock.advanceBy(100) // general refills 0.09/ms → 9 tokens in 100 ms
    await flush()
    expect(done).toBe(true)
    await pending
  })

  it('(e) order borrows idle general tokens; general never borrows the order reserve', async () => {
    // Borrow: order lane empty but general idle → an order acquire draws from general.
    const borrow = makeLimiter()
    await borrow.limiter.acquire(10, 'order') // order = 0, general = 90 idle
    await expect(borrow.limiter.acquire(5, 'order')).resolves.toBeUndefined() // borrowed

    // Guarantee: general over budget must NOT consume the order reserve — it delays,
    // and the order lane's 10 tokens remain fully available meanwhile.
    const guard = makeLimiter()
    await guard.limiter.acquire(90, 'general') // general = 0, order = 10 untouched
    let generalDone = false
    void guard.limiter.acquire(1, 'general').then(() => {
      generalDone = true
    })
    await flush()
    expect(generalDone).toBe(false) // did not raid the order reserve
    await expect(guard.limiter.acquire(10, 'order')).resolves.toBeUndefined() // reserve intact
  })
})

describe('budgetToLimiterArgs', () => {
  it('maps a published per-minute weight budget to bucket args', () => {
    expect(budgetToLimiterArgs({ weightPerMinute: 2400, reservePct: 10 })).toEqual({
      capacity: 2400,
      refillPerMs: 2400 / 60_000,
      reserveFraction: 0.1,
    })
  })
})
