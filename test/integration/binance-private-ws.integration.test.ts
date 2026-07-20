/**
 * Live private user-data WS smoke against the Binance **futures testnet** — **places no
 * orders**. Opens the real credentialed native `WebsocketClient`, subscribes the USD-M
 * user-data stream (listen key created + kept alive by the lib), holds briefly, then
 * exercises the reprime REST reads (`getBalance`/`getPositions`) the reconnect FSM uses,
 * and closes cleanly (`11` §7).
 *
 * Credential-gated: runs only with `RUN_BINANCE_PRIVATE_INTEGRATION=1` **and** testnet
 * `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET` in env. Excluded from `verify`
 * and the Postgres integration suite; offline CI skips it. Mirrors the public-WS smoke's
 * env-flag pattern.
 *
 * The listen-key keepalive (~60 min) and force-close/reconnect are owned by the native
 * lib + the shared reconnect FSM (unit-tested on a virtual clock in `private-stream.test.ts`);
 * this smoke asserts the live connect + REST reprime path, not a full keepalive hold.
 */

import { WebsocketClient } from 'binance'
import { binanceusdm } from 'ccxt'
import { describe, expect, it } from 'vitest'
import { createRealClock } from '../../src/adapters/clock/real-clock.js'
import { createBinanceAdapter } from '../../src/adapters/exchanges/binance/adapter.js'
import type { BinanceMarketClient } from '../../src/adapters/exchanges/binance/factory.js'
import type { BinancePrivateWsClient } from '../../src/adapters/exchanges/binance/private-stream.js'
import { createEventBus } from '../../src/core/events/bus.js'
import type { EngineEvent } from '../../src/core/events/types.js'

const API_KEY = process.env.BINANCE_TESTNET_API_KEY
const API_SECRET = process.env.BINANCE_TESTNET_API_SECRET
const RUN = process.env.RUN_BINANCE_PRIVATE_INTEGRATION === '1' && !!API_KEY && !!API_SECRET

describe.skipIf(!RUN)('Binance live private user-data WS (testnet)', () => {
  it('connects the user-data stream, reprimes balance via REST, then closes clean', async () => {
    const ccxt = new binanceusdm({
      apiKey: API_KEY,
      secret: API_SECRET,
      options: { defaultType: 'swap', fetchCurrencies: false },
    })
    // ccxt dropped `setSandboxMode` for USD-M futures; point the fapi hosts at testnet by
    // merging the built-in `urls.test` endpoints into the live `urls.api` map.
    ccxt.urls.api = { ...(ccxt.urls.api as Record<string, string>), ...(ccxt.urls.test as Record<string, string>) }
    const wsPrivate = new WebsocketClient({
      api_key: API_KEY,
      api_secret: API_SECRET,
      beautify: true,
      testnet: true,
    })

    const bus = createEventBus()
    const collected: EngineEvent[] = []
    bus.subscribe((e) => collected.push(e))

    const adapter = createBinanceAdapter({
      client: ccxt as unknown as BinanceMarketClient,
      clock: createRealClock(),
      wsPrivate: wsPrivate as unknown as BinancePrivateWsClient,
      bus,
    })
    await adapter.init()

    // Live subscribe — the lib fetches the listen key and opens the socket.
    await adapter.streams.private.subscribe()

    // REST reprime reads must be well-typed against the real testnet account (no orders placed).
    const balance = await adapter.getBalance()
    expect(balance.asset).toBe('USDT')
    expect(Number.isFinite(balance.free)).toBe(true)
    expect(Number.isFinite(balance.used)).toBe(true)

    const positions = await adapter.getPositions()
    expect(Array.isArray(positions)).toBe(true)
    for (const p of positions) {
      expect(typeof p.symbol).toBe('string')
      expect(p.side === 'long' || p.side === 'short').toBe(true)
      expect(Number.isFinite(p.qty)).toBe(true)
    }

    await adapter.close()
  }, 30_000)
})
