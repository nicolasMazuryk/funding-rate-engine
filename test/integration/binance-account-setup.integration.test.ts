/**
 * Live account-setup smoke against the Binance **futures testnet** (`11` §1). Applies
 * one-way position mode, isolated margin, and per-symbol leverage through the real
 * adapter, and asserts the applied-state cache makes a **second** apply a no-op — the
 * venue is called exactly **once** per op despite two calls (idempotency, `11` §1).
 *
 * Credential-gated: runs only with `RUN_BINANCE_PRIVATE_INTEGRATION=1` **and** testnet
 * `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET`. Excluded from `verify`; the
 * fake-client cache path is covered offline in `test/unit/execution/account-setup.test.ts`.
 * Testnet only — no real-money exposure. A benign `-4046` ("no need to change margin
 * type", already isolated from a prior run) is swallowed by the adapter, so a re-run is safe.
 */

import { binanceusdm } from 'ccxt'
import { describe, expect, it } from 'vitest'
import { createRealClock } from '../../src/adapters/clock/real-clock.js'
import { createBinanceAdapter } from '../../src/adapters/exchanges/binance/adapter.js'
import type { BinanceMarketClient } from '../../src/adapters/exchanges/binance/factory.js'

const API_KEY = process.env.BINANCE_TESTNET_API_KEY
const API_SECRET = process.env.BINANCE_TESTNET_API_SECRET
const RUN = process.env.RUN_BINANCE_PRIVATE_INTEGRATION === '1' && !!API_KEY && !!API_SECRET

/** The account-setup call the counting proxy tracks (per method). */
type CountedMethod = 'setLeverage' | 'setMarginMode' | 'setPositionMode'

describe.skipIf(!RUN)('Binance live account setup (testnet)', () => {
  it('applies position mode / margin / leverage; a repeat apply is a cached no-op', async () => {
    const ccxt = new binanceusdm({
      apiKey: API_KEY,
      secret: API_SECRET,
      options: { defaultType: 'swap', fetchCurrencies: false },
    })
    // ccxt dropped `setSandboxMode` for USD-M; merge the built-in testnet hosts into `urls.api`.
    ccxt.urls.api = { ...(ccxt.urls.api as Record<string, string>), ...(ccxt.urls.test as Record<string, string>) }

    // Count the underlying venue calls per account-setup method.
    const counts: Record<CountedMethod, number> = { setLeverage: 0, setMarginMode: 0, setPositionMode: 0 }
    const counting = new Proxy(ccxt as unknown as BinanceMarketClient, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof prop === 'string' && prop in counts && typeof value === 'function') {
          return (...args: unknown[]) => {
            counts[prop as CountedMethod]++
            return (value as (...a: unknown[]) => unknown).apply(target, args)
          }
        }
        return typeof value === 'function' ? value.bind(target) : value
      },
    })

    const adapter = createBinanceAdapter({ client: counting, clock: createRealClock() })
    await adapter.init()

    const symbol = adapter.markets()[0]?.normalized
    expect(symbol).toBeDefined()
    if (symbol === undefined) return

    // Apply twice; the applied-state cache must collapse each to a single venue call.
    await adapter.setPositionMode('one_way')
    await adapter.setPositionMode('one_way')
    await adapter.setMarginMode(symbol, 'isolated')
    await adapter.setMarginMode(symbol, 'isolated')
    await adapter.setLeverage(symbol, 5)
    await adapter.setLeverage(symbol, 5)

    expect(counts.setPositionMode).toBe(1)
    expect(counts.setMarginMode).toBe(1)
    expect(counts.setLeverage).toBe(1)

    await adapter.close()
  })
})
