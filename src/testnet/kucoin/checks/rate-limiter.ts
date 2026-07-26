/**
 * Rate-limiter check (`17` §3 bullet 6, `10` §6). Assert-by-construction, not a live 429 (which
 * on this venue would be induced against a **live** account): builds the real limiter
 * (`createKucoinRateLimiter`) from the committed `exchanges.yaml` KuCoin profile — the same
 * profile the adapter under test was built from — and asserts both that the budget derivation
 * holds and that a full general-lane drain cannot starve the order lane.
 *
 * **The arithmetic here is weights, not requests.** Bybit/OKX/Bitget publish request *counts*,
 * so their checks divide a per-minute budget by 60 and compare against a req/s cap; that
 * comparison is meaningless on KuCoin. KuCoin bills a published **per-endpoint weight** against
 * a per-UID **resource pool** of 2000 weight over a rolling **30 s** window (exhaustion → HTTP
 * 429 + venue code `429000`). So the three claims in the `rate_limit_weight_per_minute` comment
 * in `config/exchanges.yaml` are what gets asserted, in the pool's own 30 s unit:
 *
 *   1. the pool is budgeted at 90 % — 3600 weight/min = **1800 per 30 s**, inside the 2000 pool,
 *      leaving headroom for anything outside the limiter's accounting;
 *   2. the order lane's 33 % reserve = 1188 weight/min ÷ **2** (the add-order weight the
 *      transport actually charges) = **594 orders/min ≈ 9.9/s**, which is exactly what the
 *      100 ms submission stagger asks for and stays under 10/s;
 *   3. the general lane's 67 % = 2412 weight/min = **1206 per 30 s**, which fits alongside the
 *      order lane's 594 per 30 s inside the same pool.
 */

import { createRealClock } from '../../../adapters/clock/real-clock.js'
import { createKucoinRateLimiter } from '../../../adapters/exchanges/kucoin/factory.js'
import type { KucoinLiveContext } from '../../context.js'
import type { Check } from '../../types.js'

/** The venue's per-UID futures resource pool, in weight per rolling 30 s window (VIP0). */
const POOL_WEIGHT_PER_WINDOW = 2000
const WINDOW_SECONDS = 30
const SECONDS_PER_MINUTE = 60

/**
 * Published weight of one add-order call, i.e. what the order lane is really denominated in
 * (`kucoin/ws-orders.ts` charges the same 2 on both the WS and the REST submit path). A cancel
 * is cheaper (1), so budgeting at the add-order weight is the conservative direction.
 */
const ADD_ORDER_WEIGHT = 2

/** The submission stagger (100 ms) is what the order lane must be able to sustain: 10/s. */
const TARGET_ORDERS_PER_SECOND = 10

export const rateLimiterCheck: Check<KucoinLiveContext> = {
  name: 'rate-limiter',
  specRef: '17 §3 rate limiter',
  async run(ctx) {
    const profile = ctx.profile

    const clock = createRealClock()
    const limiter = createKucoinRateLimiter(profile, clock)

    const orderWeightPerMinute = profile.rateLimitWeightPerMinute * (profile.rateLimitReservePct / 100)
    const generalWeightPerMinute = profile.rateLimitWeightPerMinute - orderWeightPerMinute

    // (1) The whole budget must fit the pool's own 30 s window, with headroom.
    const budgetPerWindow = (profile.rateLimitWeightPerMinute / SECONDS_PER_MINUTE) * WINDOW_SECONDS
    if (budgetPerWindow > POOL_WEIGHT_PER_WINDOW) {
      throw new Error(
        `KuCoin budget is ${profile.rateLimitWeightPerMinute} weight/min = ${budgetPerWindow} per ${WINDOW_SECONDS}s, over the ${POOL_WEIGHT_PER_WINDOW} pool`,
      )
    }

    // (2) The order reserve, converted from weight to *orders* — the unit the stagger speaks.
    const ordersPerMinute = orderWeightPerMinute / ADD_ORDER_WEIGHT
    const ordersPerSecond = ordersPerMinute / SECONDS_PER_MINUTE
    if (ordersPerSecond > TARGET_ORDERS_PER_SECOND) {
      throw new Error(
        `KuCoin order reserve is ${orderWeightPerMinute} weight/min = ${ordersPerMinute} orders/min (${ordersPerSecond}/s), over the ${TARGET_ORDERS_PER_SECOND}/s the 100ms stagger implies`,
      )
    }

    // (3) Both lanes together must still fit one window of the pool.
    const orderWeightPerWindow = (orderWeightPerMinute / SECONDS_PER_MINUTE) * WINDOW_SECONDS
    const generalWeightPerWindow = (generalWeightPerMinute / SECONDS_PER_MINUTE) * WINDOW_SECONDS
    if (orderWeightPerWindow + generalWeightPerWindow > POOL_WEIGHT_PER_WINDOW) {
      throw new Error(
        `lanes sum to ${orderWeightPerWindow + generalWeightPerWindow} weight per ${WINDOW_SECONDS}s, over the ${POOL_WEIGHT_PER_WINDOW} pool`,
      )
    }

    // Drain the general lane fully — must not touch the order reserve.
    await limiter.acquire(generalWeightPerMinute, 'general')
    // The order lane must still admit its full reserve, untouched by the general drain.
    await limiter.acquire(orderWeightPerMinute, 'order')

    return {
      status: 'pass',
      detail: {
        weightPerMinute: profile.rateLimitWeightPerMinute,
        reservePct: profile.rateLimitReservePct,
        orderWeightPerMinute,
        generalWeightPerMinute,
        addOrderWeight: ADD_ORDER_WEIGHT,
        ordersPerMinute,
        ordersPerSecond,
        perWindow: {
          windowSeconds: WINDOW_SECONDS,
          order: orderWeightPerWindow,
          general: generalWeightPerWindow,
          pool: POOL_WEIGHT_PER_WINDOW,
        },
      },
    }
  },
}
