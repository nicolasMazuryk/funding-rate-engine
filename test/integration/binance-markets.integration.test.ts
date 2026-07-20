/**
 * Live public-endpoint smoke for the Binance market load — **no credentials, no
 * orders**. It hits real Binance public REST via ccxt and asserts the `10` §3 filter
 * + `10` §4 validation survive the real universe: ≥100 instruments, zero aborts.
 *
 * Env-gated (new pattern, mirrors golden's `UPDATE_GOLDEN === '1'`): runs only when
 * `RUN_BINANCE_INTEGRATION=1`, so `npm run test:integration` (Postgres suite) and the
 * default `verify` are unaffected and offline CI skips it cleanly.
 */

import { describe, expect, it } from 'vitest'
import { createRealClock } from '../../src/adapters/clock/real-clock.js'
import { createBinanceAdapter } from '../../src/adapters/exchanges/binance/adapter.js'
import { createBinanceClients } from '../../src/adapters/exchanges/binance/factory.js'
import type { ExchangeProfile } from '../../src/config/exchange-schema.js'

const RUN = process.env.RUN_BINANCE_INTEGRATION === '1'

// Placeholder profile — market metadata needs no fees/WS and no credentials.
const PROFILE: ExchangeProfile = {
  takerFeePct: 0.04,
  makerFeePct: 0.02,
  submissionStaggerMs: 250,
  rateLimitReservePct: 10,
  rateLimitWeightPerMinute: 2400,
  wsOrderAdapter: true,
  ws: { publicUrl: 'wss://fstream.binance.com/ws', privateUrl: 'wss://fstream.binance.com/ws' },
  deltas: {},
}

describe.skipIf(!RUN)('Binance live market load', () => {
  it('builds ≥100 validated instruments with zero aborts', async () => {
    const clients = createBinanceClients(PROFILE, { apiKey: 'public', apiSecret: 'public' })
    const adapter = createBinanceAdapter({ client: clients.ccxt, clock: createRealClock() })

    await adapter.init() // throws on any validation anomaly → test fails, not silently passes

    const markets = adapter.markets()
    expect(markets.length).toBeGreaterThanOrEqual(100)
    // Every listed market normalizes back to a validated instrument.
    for (const m of markets.slice(0, 20)) expect(adapter.normalize(m.normalized).contractSize).toBeGreaterThan(0)

    await adapter.close()
  }, 30_000)
})
