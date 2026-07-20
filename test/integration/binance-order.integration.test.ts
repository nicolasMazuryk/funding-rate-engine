/**
 * Live order smoke against the Binance **futures testnet** — places **one** far-from-market
 * limit order over the native WS-API, confirms it rests `OPEN` via REST `getOrder`, then
 * cancels it and confirms `CANCELLED` (`11` §5/§6). Real credentials, real venue, but the
 * order is priced far from market so it never fills.
 *
 * Credential-gated: runs only with `RUN_BINANCE_PRIVATE_INTEGRATION=1` **and** testnet
 * `BINANCE_TESTNET_API_KEY` / `BINANCE_TESTNET_API_SECRET` in env. Excluded from `verify`;
 * offline CI skips it. Mirrors the private-WS smoke's env-flag pattern.
 *
 * The adopt-on-retry + REST-fallback branches are venue-neutral and unit-tested on a fake
 * transport (`order-manager.test.ts`) — Binance runs WS-mandatory (`ws_order_rest_fallback:
 * false`), so no live path forces a WS timeout here.
 */

import { USDMClient, WebsocketAPIClient } from 'binance'
import { binanceusdm } from 'ccxt'
import { describe, expect, it } from 'vitest'
import { createRealClock } from '../../src/adapters/clock/real-clock.js'
import { createBinanceAdapter } from '../../src/adapters/exchanges/binance/adapter.js'
import type { BinanceMarketClient } from '../../src/adapters/exchanges/binance/factory.js'
import type { BinanceRestOrderClient, BinanceWsOrderClient } from '../../src/adapters/exchanges/binance/ws-orders.js'
import { createEventBus } from '../../src/core/events/bus.js'
import type { OrderUpdate } from '../../src/core/events/types.js'
import { makeClientOrderId } from '../../src/core/order-id/client-order-id.js'

const API_KEY = process.env.BINANCE_TESTNET_API_KEY
const API_SECRET = process.env.BINANCE_TESTNET_API_SECRET
const RUN = process.env.RUN_BINANCE_PRIVATE_INTEGRATION === '1' && !!API_KEY && !!API_SECRET

describe.skipIf(!RUN)('Binance live order path (testnet)', () => {
  it('submits a far-from-market limit order, confirms OPEN, then cancels to CANCELLED', async () => {
    const ccxt = new binanceusdm({
      apiKey: API_KEY,
      secret: API_SECRET,
      options: { defaultType: 'swap', fetchCurrencies: false },
    })
    ccxt.urls.api = { ...(ccxt.urls.api as Record<string, string>), ...(ccxt.urls.test as Record<string, string>) }
    const wsApiPrivate = new WebsocketAPIClient({ api_key: API_KEY, api_secret: API_SECRET, testnet: true })
    const restOrders = new USDMClient({ api_key: API_KEY, api_secret: API_SECRET, testnet: true })

    const bus = createEventBus()
    const updates: OrderUpdate[] = []
    bus.subscribe((e) => {
      if (e.type === 'OrderUpdate') updates.push(e)
    })

    const adapter = createBinanceAdapter({
      client: ccxt as unknown as BinanceMarketClient,
      clock: createRealClock(),
      wsApiPrivate: wsApiPrivate as unknown as BinanceWsOrderClient,
      restOrders: restOrders as unknown as BinanceRestOrderClient,
      bus,
      submissionStaggerMs: 100,
      wsOrderRestFallback: false,
    })
    await adapter.init()

    // A BTC long limit far below market never fills on testnet; qty × price ≥ 50 (min notional).
    const price = 20_000
    const clientOrderId = makeClientOrderId({ intentId: `BTC-${Date.now()}`, leg: 'entry', attempt: 1 })
    const placed = await adapter.placeOrder({
      symbol: 'BTC',
      side: 'long',
      type: 'limit',
      qty: 0.003,
      price,
      clientOrderId,
    })
    expect(placed.accepted).toBe(true)

    const resting = await adapter.getOrder(clientOrderId)
    expect(resting.status).toBe('OPEN')

    await adapter.cancelOrder(clientOrderId)
    const cancelled = await adapter.getOrder(clientOrderId)
    expect(cancelled.status).toBe('CANCELLED')

    await adapter.close()
  }, 30_000)
})
