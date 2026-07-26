/**
 * Rate-limiter check (`17` §3 bullet 6, `10` §6). Assert-by-construction, not a live 429:
 * builds the real per-venue limiter (`createOkxRateLimiter`) from the committed
 * `exchanges.yaml` OKX profile (the same profile the adapter under test was built from,
 * `context.ts`) and asserts the order lane's reserve survives a full general-lane drain —
 * i.e. polling can never starve the order path. Deliberately does not wait on a real refill
 * (would hang the harness on a real clock).
 *
 * OKX-specific: like Bybit the venue publishes **no weight model**, but unlike Bybit there is
 * no IP-wide aggregate to size against — each read endpoint carries its own 20 req/2 s per-IP
 * cap and orders are capped per instrument (60 req/2 s). So the profile uses a **50 %**
 * reserve on 1200/min to make *both* lanes true at once: 600/min order (= 10/s, matching the
 * 100 ms submission stagger) and 600/min general (= 20 req/2 s = exactly one read endpoint's
 * cap, the honest bound when every read could hit the same endpoint). That arithmetic is the
 * whole point of the two numbers, so it is asserted here rather than left as a YAML comment.
 */

import { createRealClock } from '../../../adapters/clock/real-clock.js'
import { createOkxRateLimiter } from '../../../adapters/exchanges/okx/factory.js'
import type { OkxTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** One read endpoint's published per-IP cap: 20 requests per 2 s. */
const VENUE_READ_CAP_PER_SECOND = 10
/** The order rate the 100 ms submission stagger implies, well under the venue's 30/s per instrument. */
const ORDER_RATE_PER_SECOND = 10
const SECONDS_PER_MINUTE = 60

export const rateLimiterCheck: Check<OkxTestnetContext> = {
  name: 'rate-limiter',
  specRef: '17 §3 rate limiter',
  async run(ctx) {
    const profile = ctx.profile

    const clock = createRealClock()
    const limiter = createOkxRateLimiter(profile, clock)

    const orderCap = profile.rateLimitWeightPerMinute * (profile.rateLimitReservePct / 100)
    const generalCap = profile.rateLimitWeightPerMinute - orderCap

    const expectedOrderCap = ORDER_RATE_PER_SECOND * SECONDS_PER_MINUTE
    if (orderCap !== expectedOrderCap) {
      throw new Error(`OKX order reserve is ${orderCap}/min, expected ${expectedOrderCap}/min (= 10/s)`)
    }
    const expectedGeneralCap = VENUE_READ_CAP_PER_SECOND * SECONDS_PER_MINUTE
    if (generalCap !== expectedGeneralCap) {
      throw new Error(
        `OKX general lane is ${generalCap}/min, expected ${expectedGeneralCap}/min (= 20 req/2 s, one read endpoint's cap)`,
      )
    }

    // Drain the general lane fully — must not touch the order reserve.
    await limiter.acquire(generalCap, 'general')
    // The order lane must still admit its full reserve, untouched by the general drain.
    await limiter.acquire(orderCap, 'order')

    return { status: 'pass', detail: { weightPerMinute: profile.rateLimitWeightPerMinute, orderCap, generalCap } }
  },
}
