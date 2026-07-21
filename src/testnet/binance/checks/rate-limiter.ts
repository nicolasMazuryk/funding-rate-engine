/**
 * Rate-limiter check (`17` §3 bullet 6, `10` §6). Assert-by-construction, not a live
 * 429: builds the real per-venue limiter (`createBinanceRateLimiter`) from the
 * committed `exchanges.yaml` Binance profile and asserts the order lane's reserve
 * survives a full general-lane drain — i.e. polling can never starve the order path.
 * Deliberately does not wait on a real refill (would hang the harness on a real
 * clock); it only exercises the always-available reserved capacity.
 */

import { readFileSync } from 'node:fs'
import { createRealClock } from '../../../adapters/clock/real-clock.js'
import { createBinanceRateLimiter } from '../../../adapters/exchanges/binance/factory.js'
import { parseExchangeProfiles } from '../../../config/exchange-schema.js'
import type { BinanceTestnetContext } from '../../context.js'
import type { Check } from '../../types.js'

export const rateLimiterCheck: Check<BinanceTestnetContext> = {
  name: 'rate-limiter',
  specRef: '17 §3 rate limiter',
  async run() {
    const yamlText = readFileSync('config/exchanges.yaml', 'utf8')
    const profiles = parseExchangeProfiles(yamlText)
    const profile = profiles.binance

    const clock = createRealClock()
    const limiter = createBinanceRateLimiter(profile, clock)

    const orderCap = profile.rateLimitWeightPerMinute * (profile.rateLimitReservePct / 100)
    const generalCap = profile.rateLimitWeightPerMinute - orderCap

    // Drain the general lane fully — must not touch the order reserve.
    await limiter.acquire(generalCap, 'general')
    // The order lane must still admit its full reserve, untouched by the general drain.
    await limiter.acquire(orderCap, 'order')

    return { status: 'pass', detail: { weightPerMinute: profile.rateLimitWeightPerMinute, orderCap, generalCap } }
  },
}
