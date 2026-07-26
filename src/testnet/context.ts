/**
 * Testnet check context (task 0260). Builds the adapter/clients **once** per CLI run
 * from env creds via the testnet-capable factory (`factory.ts` `network: 'testnet'`,
 * DRYing the url-merge previously duplicated inline in `capture-binance.ts` and the
 * integration smokes) and exposes the narrow surface checks need. `onCleanup` here is
 * a no-op placeholder — `runner.ts` overrides it per-check.
 *
 * One builder per venue (Binance task 0260, Bybit task 0420, OKX task 0430). They share the
 * {@link CheckContext} shape and nothing else — the clients they expose are the venue's
 * own concrete types, since the checks that need raw client access (`assert-flat`,
 * `error-taxonomy`) are venue-specific by construction. No premature abstraction: a
 * common "venue context" interface would only be the union of three client sets.
 */

import { readFileSync } from 'node:fs'
import { createRealClock } from '../adapters/clock/real-clock.js'
import { createBinanceAdapter } from '../adapters/exchanges/binance/adapter.js'
import { type BinanceClients, createBinanceClients } from '../adapters/exchanges/binance/factory.js'
import { createBybitAdapter } from '../adapters/exchanges/bybit/adapter.js'
import { type BybitClients, createBybitClients, createBybitRateLimiter } from '../adapters/exchanges/bybit/factory.js'
import { createOkxAdapter } from '../adapters/exchanges/okx/adapter.js'
import { createOkxClients, createOkxRateLimiter, type OkxClients } from '../adapters/exchanges/okx/factory.js'
import { type ExchangeProfile, parseExchangeProfiles } from '../config/exchange-schema.js'
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

// ── Bybit (task 0420) ────────────────────────────────────────────────────────

/** Committed venue profile path — the checks assert against the real config, not a copy. */
const EXCHANGES_YAML = 'config/exchanges.yaml'

export function hasBybitTestnetCredentials(): boolean {
  return !!process.env.BYBIT_TESTNET_API_KEY && !!process.env.BYBIT_TESTNET_API_SECRET
}

export interface BybitTestnetContext extends CheckContext {
  readonly adapter: ExchangeAdapter
  /** Raw ccxt/native clients — `assert-flat` needs `fetchOpenOrders`/`cancelOrder` and
   * `error-taxonomy`/`account-setup` the native `RestClientV5`, surfaces the
   * `ExchangeAdapter` port deliberately doesn't expose generically. */
  readonly clients: BybitClients
  readonly clock: Clock
  readonly bus: EventBus
  readonly events: readonly EngineEvent[]
  /**
   * The **committed** `config/exchanges.yaml` Bybit profile (not a placeholder): the
   * adapter under test is built from it, so `deltas`/`rate-limiter` assert the shipped
   * numbers rather than a copy that could drift.
   */
  readonly profile: ExchangeProfile
  /** Free quote-asset balance — the fund-dependent checks' self-gate. */
  getBalanceFree(): Promise<number>
}

/** Build the shared adapter/clients once; every check in the registry reuses this one context. */
export async function createBybitTestnetContext(): Promise<BybitTestnetContext> {
  const hasCredentials = hasBybitTestnetCredentials()
  const apiKey = process.env.BYBIT_TESTNET_API_KEY ?? 'public'
  const apiSecret = process.env.BYBIT_TESTNET_API_SECRET ?? 'public'

  const clock = createRealClock()
  const bus = createEventBus()
  const events: EngineEvent[] = []
  bus.subscribe((e) => events.push(e))

  const profile = parseExchangeProfiles(readFileSync(EXCHANGES_YAML, 'utf8')).bybit
  const clients = createBybitClients(profile, { apiKey, apiSecret }, { network: 'testnet' })
  const adapter = createBybitAdapter({
    client: clients.ccxt,
    clock,
    limiter: createBybitRateLimiter(profile, clock),
    accountSetup: clients.native,
    ws: clients.wsPublic,
    wsPrivate: clients.wsPrivate,
    wsApiPrivate: clients.wsApiPrivate,
    restOrders: clients.native,
    bus,
    submissionStaggerMs: profile.submissionStaggerMs,
    wsOrderRestFallback: profile.deltas.wsOrderRestFallback ?? false,
  })
  await adapter.init()

  return {
    hasCredentials,
    adapter,
    clients,
    clock,
    bus,
    events,
    profile,
    onCleanup: () => {},
    async getBalanceFree(): Promise<number> {
      const balance = await adapter.getBalance()
      return balance.free
    },
  }
}

// ── OKX (task 0430, demo trading) ────────────────────────────────────────────

/**
 * OKX signs with **three** credentials, so the probe is a three-way `and`: a key/secret pair
 * without the passphrase cannot sign a single private call (`50104`), and the factory refuses
 * to build clients from it. `OKX_TESTNET_PASSPHRASE` (not `_API_PASSPHRASE`) matches the
 * `<VENUE>_TESTNET_*` naming the two prior venues established.
 */
export function hasOkxTestnetCredentials(): boolean {
  return (
    !!process.env.OKX_TESTNET_API_KEY && !!process.env.OKX_TESTNET_API_SECRET && !!process.env.OKX_TESTNET_PASSPHRASE
  )
}

export interface OkxTestnetContext extends CheckContext {
  readonly adapter: ExchangeAdapter
  /**
   * Raw ccxt/native clients — `assert-flat` needs the raw open-order rows (`instId`/`clOrdId`)
   * and `account-setup`/`error-taxonomy` the native `RestClient`, surfaces the
   * `ExchangeAdapter` port deliberately doesn't expose generically.
   */
  readonly clients: OkxClients
  readonly clock: Clock
  readonly bus: EventBus
  readonly events: readonly EngineEvent[]
  /**
   * The **committed** `config/exchanges.yaml` OKX profile, as on Bybit — `deltas`/`rate-limiter`
   * assert the shipped numbers, and the adapter under test is built from the same object.
   */
  readonly profile: ExchangeProfile
  /** Free quote-asset balance — the fund-dependent checks' self-gate. */
  getBalanceFree(): Promise<number>
}

/**
 * Build the shared adapter/clients once; every check in the registry reuses this one context.
 *
 * OKX demo trading is a **flag**, not a network: `network: 'testnet'` sets `demoTrading: true`
 * on the native clients and ccxt's sandbox header on the same account's keys, so there is no
 * separate REST host to merge in (only the WS host differs, and the SDK owns that).
 */
export async function createOkxTestnetContext(): Promise<OkxTestnetContext> {
  const hasCredentials = hasOkxTestnetCredentials()
  const apiKey = process.env.OKX_TESTNET_API_KEY ?? 'public'
  const apiSecret = process.env.OKX_TESTNET_API_SECRET ?? 'public'
  // The factory fails loud on an absent passphrase, so the credential-free path supplies the
  // same placeholder as the other two credentials — every check then skips on `hasCredentials`.
  const apiPassphrase = process.env.OKX_TESTNET_PASSPHRASE ?? 'public'

  const clock = createRealClock()
  const bus = createEventBus()
  const events: EngineEvent[] = []
  bus.subscribe((e) => events.push(e))

  const profile = parseExchangeProfiles(readFileSync(EXCHANGES_YAML, 'utf8')).okx
  const clients = createOkxClients(profile, { apiKey, apiSecret, apiPassphrase }, { network: 'testnet' })
  const adapter = createOkxAdapter({
    client: clients.ccxt,
    clock,
    limiter: createOkxRateLimiter(profile, clock),
    accountSetup: clients.native,
    ws: clients.wsPublic,
    wsPrivate: clients.wsPrivate,
    wsApiPrivate: clients.wsApiPrivate,
    restOrders: clients.native,
    bus,
    submissionStaggerMs: profile.submissionStaggerMs,
    wsOrderRestFallback: profile.deltas.wsOrderRestFallback ?? false,
  })
  await adapter.init()

  return {
    hasCredentials,
    adapter,
    clients,
    clock,
    bus,
    events,
    profile,
    onCleanup: () => {},
    async getBalanceFree(): Promise<number> {
      const balance = await adapter.getBalance()
      return balance.free
    },
  }
}
