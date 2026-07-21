/**
 * Testnet check context (task 0260). Builds the adapter/clients **once** per CLI run
 * from env creds via the testnet-capable factory (`factory.ts` `network: 'testnet'`,
 * DRYing the url-merge previously duplicated inline in `capture-binance.ts` and the
 * integration smokes) and exposes the narrow surface checks need. `onCleanup` here is
 * a no-op placeholder — `runner.ts` overrides it per-check.
 */

import { createRealClock } from '../adapters/clock/real-clock.js'
import { createBinanceAdapter } from '../adapters/exchanges/binance/adapter.js'
import { type BinanceClients, createBinanceClients } from '../adapters/exchanges/binance/factory.js'
import type { ExchangeProfile } from '../config/exchange-schema.js'
import { createEventBus } from '../core/events/bus.js'
import type { EngineEvent } from '../core/events/types.js'
import type { EventBus } from '../core/ports/bus.js'
import type { Clock } from '../core/ports/clock.js'
import type { ExchangeAdapter } from '../core/ports/exchange-adapter.js'
import type { CheckContext } from './types.js'

/** Bumped whenever the check registry or summary shape changes in a way worth tracking. */
export const TESTNET_TOOL_VERSION = '1'

/**
 * Minimal profile the testnet harness needs — fees/rate-limit fields are unused by
 * the checks below (no order-cost math here), but the factory/adapter signatures
 * require a full {@link ExchangeProfile}. Mirrors the placeholder profile already
 * used by the integration smokes this task folds.
 */
const PROFILE: ExchangeProfile = {
  takerFeePct: 0.05,
  makerFeePct: 0.02,
  submissionStaggerMs: 100,
  rateLimitReservePct: 10,
  rateLimitWeightPerMinute: 2400,
  wsOrderAdapter: true,
  ws: { publicUrl: 'wss://fstream.binance.com/ws', privateUrl: 'wss://fstream.binance.com/ws' },
  deltas: {},
}

export function hasBinanceTestnetCredentials(): boolean {
  return !!process.env.BINANCE_TESTNET_API_KEY && !!process.env.BINANCE_TESTNET_API_SECRET
}

export interface BinanceTestnetContext extends CheckContext {
  readonly adapter: ExchangeAdapter
  /** Raw ccxt/native clients — `assert-flat` needs `fetchOpenOrders`/`cancelFuturesOrder`, a
   * surface the `ExchangeAdapter` port deliberately doesn't expose generically. */
  readonly clients: BinanceClients
  readonly clock: Clock
  readonly bus: EventBus
  readonly events: readonly EngineEvent[]
  /** Free quote-asset balance — the fund-dependent checks' self-gate. */
  getBalanceFree(): Promise<number>
}

/** Build the shared adapter/clients once; every check in the registry reuses this one context. */
export async function createBinanceTestnetContext(): Promise<BinanceTestnetContext> {
  const hasCredentials = hasBinanceTestnetCredentials()
  const apiKey = process.env.BINANCE_TESTNET_API_KEY ?? 'public'
  const apiSecret = process.env.BINANCE_TESTNET_API_SECRET ?? 'public'

  const clock = createRealClock()
  const bus = createEventBus()
  const events: EngineEvent[] = []
  bus.subscribe((e) => events.push(e))

  const clients = createBinanceClients(PROFILE, { apiKey, apiSecret }, { network: 'testnet' })
  const adapter = createBinanceAdapter({
    client: clients.ccxt,
    clock,
    ws: clients.wsPublic,
    wsPrivate: clients.wsPrivate,
    wsApiPrivate: clients.wsApiPrivate,
    restOrders: clients.native,
    bus,
    submissionStaggerMs: PROFILE.submissionStaggerMs,
    wsOrderRestFallback: false,
  })
  await adapter.init()

  return {
    hasCredentials,
    adapter,
    clients,
    clock,
    bus,
    events,
    onCleanup: () => {},
    async getBalanceFree(): Promise<number> {
      const balance = await adapter.getBalance()
      return balance.free
    },
  }
}
