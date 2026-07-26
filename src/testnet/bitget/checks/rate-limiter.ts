/**
 * Rate-limiter check (`17` §3 bullet 6, `10` §6). Assert-by-construction, not a live 429:
 * builds the real per-venue limiter (`createBitgetRateLimiter`) from the committed
 * `exchanges.yaml` Bitget profile (the same profile the adapter under test was built from,
 * `context.ts`) and asserts the order lane's reserve survives a full general-lane drain —
 * i.e. polling can never starve the order path. Deliberately does not wait on a real refill
 * (would hang the harness on a real clock).
 *
 * Bitget-specific: the venue publishes **no weight model** — the UTA caps are request counts
 * per UID (10/s place-order, 20/s order reads) — so 1800/min at a **33 %** reserve is what
 * makes both lanes true at once: order 594/min ≈ 9.9/s (under the 10/s cap and matching the
 * 100 ms submission stagger), general 1206/min ≈ 20/s (the read cap). That arithmetic is the
 * whole point of the two numbers, so it is asserted here rather than left as a YAML comment.
 */

import { createRealClock } from '../../../adapters/clock/real-clock.js'
import { createBitgetRateLimiter } from '../../../adapters/exchanges/bitget/factory.js'
import type { BitgetTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

/** The venue's per-UID caps: 10 place-order/s, 20 order-info reads/s. */
const VENUE_ORDER_CAP_PER_SECOND = 10
const VENUE_READ_CAP_PER_SECOND = 20
const SECONDS_PER_MINUTE = 60

export const rateLimiterCheck: Check<BitgetTestnetContext> = {
  name: 'rate-limiter',
  specRef: '17 §3 rate limiter',
  async run(ctx) {
    const profile = ctx.profile

    const clock = createRealClock()
    const limiter = createBitgetRateLimiter(profile, clock)

    const orderCap = profile.rateLimitWeightPerMinute * (profile.rateLimitReservePct / 100)
    const generalCap = profile.rateLimitWeightPerMinute - orderCap

    // Both lanes must sit **under** the venue's true per-UID caps, since every call costs 1.
    const orderPerSecond = orderCap / SECONDS_PER_MINUTE
    if (orderPerSecond > VENUE_ORDER_CAP_PER_SECOND) {
      throw new Error(
        `Bitget order reserve is ${orderCap}/min (${orderPerSecond}/s), over the ${VENUE_ORDER_CAP_PER_SECOND}/s venue cap`,
      )
    }
    const generalPerSecond = generalCap / SECONDS_PER_MINUTE
    if (generalPerSecond > VENUE_READ_CAP_PER_SECOND) {
      throw new Error(
        `Bitget general lane is ${generalCap}/min (${generalPerSecond}/s), over the ${VENUE_READ_CAP_PER_SECOND}/s read cap`,
      )
    }

    // Drain the general lane fully — must not touch the order reserve.
    await limiter.acquire(generalCap, 'general')
    // The order lane must still admit its full reserve, untouched by the general drain.
    await limiter.acquire(orderCap, 'order')

    return {
      status: 'pass',
      detail: {
        weightPerMinute: profile.rateLimitWeightPerMinute,
        orderCap,
        generalCap,
        orderPerSecond,
        generalPerSecond,
      },
    }
  },
}
