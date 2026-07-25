/**
 * Rate-limiter check (`17` §3 bullet 6, `10` §6). Assert-by-construction, not a live 429:
 * builds the real per-venue limiter (`createBybitRateLimiter`) from the committed
 * `exchanges.yaml` Bybit profile (the same profile the adapter under test was built from,
 * `context.ts`) and asserts the order lane's reserve survives a full general-lane drain —
 * i.e. polling can never starve the order path. Deliberately does not wait on a real refill
 * (would hang the harness on a real clock).
 *
 * Bybit-specific: the venue publishes **no weight model** (D2) — its caps are request
 * counts, 10 order ops/s per UID — so the profile's 6000/min budget with a 10 % order
 * reserve is what makes the reserved lane exactly 600/min = 10/s. That arithmetic is the
 * whole point of the number, so it is asserted here rather than left as a YAML comment.
 */

import { createRealClock } from '../../../adapters/clock/real-clock.js'
import { createBybitRateLimiter } from '../../../adapters/exchanges/bybit/factory.js'
import type { BybitTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** The venue's real order cap (`/v5/order/create` etc.): 10 per second per UID. */
const VENUE_ORDER_CAP_PER_SECOND = 10
const SECONDS_PER_MINUTE = 60

export const rateLimiterCheck: Check<BybitTestnetContext> = {
  name: 'rate-limiter',
  specRef: '17 §3 rate limiter',
  async run(ctx) {
    const profile = ctx.profile

    const clock = createRealClock()
    const limiter = createBybitRateLimiter(profile, clock)

    const orderCap = profile.rateLimitWeightPerMinute * (profile.rateLimitReservePct / 100)
    const generalCap = profile.rateLimitWeightPerMinute - orderCap

    // The budget must express the venue's true order cap, since every Bybit call costs 1.
    const expectedOrderCap = VENUE_ORDER_CAP_PER_SECOND * SECONDS_PER_MINUTE
    if (orderCap !== expectedOrderCap) {
      throw new Error(
        `Bybit order reserve is ${orderCap}/min, expected ${expectedOrderCap}/min (= ${VENUE_ORDER_CAP_PER_SECOND}/s venue cap)`,
      )
    }

    // Drain the general lane fully — must not touch the order reserve.
    await limiter.acquire(generalCap, 'general')
    // The order lane must still admit its full reserve, untouched by the general drain.
    await limiter.acquire(orderCap, 'order')

    return { status: 'pass', detail: { weightPerMinute: profile.rateLimitWeightPerMinute, orderCap, generalCap } }
  },
}
