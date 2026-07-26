/**
 * Testnet check context (task 0260). Builds the adapter/clients **once** per CLI run
 * from env creds via the testnet-capable factory (`factory.ts` `network: 'testnet'`,
 * DRYing the url-merge previously duplicated inline in `capture-binance.ts` and the
 * integration smokes) and exposes the narrow surface checks need. `onCleanup` here is
 * a no-op placeholder — `runner.ts` overrides it per-check.
 *
 * One builder per venue (Binance task 0260, Bybit task 0420, OKX task 0430, Bitget task 0440,
 * KuCoin task 0460 — the last of which is **live read-only**, not a testnet, see its section).
 * They share the {@link CheckContext} shape and nothing else — the clients they expose are the
 * venue's own concrete types, since the checks that need raw client access (`assert-flat`,
 * `error-taxonomy`) are venue-specific by construction. No premature abstraction: a
 * common "venue context" interface would only be the union of four client sets.
 */

import { readFileSync } from 'node:fs'
import { WS_KEY_MAP } from 'bitget-api'
import { WS_KEY_MAP as KUCOIN_WS_KEY_MAP } from 'kucoin-api'
import { createRealClock } from '../adapters/clock/real-clock.js'
import { createBinanceAdapter } from '../adapters/exchanges/binance/adapter.js'
import { type BinanceClients, createBinanceClients } from '../adapters/exchanges/binance/factory.js'
import { createBitgetAdapter } from '../adapters/exchanges/bitget/adapter.js'
import {
  type BitgetClients,
  createBitgetClients,
  createBitgetRateLimiter,
} from '../adapters/exchanges/bitget/factory.js'
import { createBybitAdapter } from '../adapters/exchanges/bybit/adapter.js'
import { type BybitClients, createBybitClients, createBybitRateLimiter } from '../adapters/exchanges/bybit/factory.js'
import { createKucoinAdapter } from '../adapters/exchanges/kucoin/adapter.js'
import {
  createKucoinClients,
  createKucoinRateLimiter,
  type KucoinClients,
} from '../adapters/exchanges/kucoin/factory.js'
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

// ── Bitget (task 0440, UTA demo trading) ─────────────────────────────────────

/**
 * Bitget signs with three credentials, as OKX does, so the probe is the same three-way `and`:
 * key + secret without the passphrase cannot sign a private call (`40011`), and the factory
 * refuses to build clients from it. `BITGET_TESTNET_PASSPHRASE` keeps the `<VENUE>_TESTNET_*`
 * naming the prior venues established.
 */
export function hasBitgetTestnetCredentials(): boolean {
  return (
    !!process.env.BITGET_TESTNET_API_KEY &&
    !!process.env.BITGET_TESTNET_API_SECRET &&
    !!process.env.BITGET_TESTNET_PASSPHRASE
  )
}

export interface BitgetTestnetContext extends CheckContext {
  readonly adapter: ExchangeAdapter
  /**
   * Raw ccxt/native clients — `assert-flat` needs the raw open-order rows (`symbol`/`orderId`)
   * and `account-setup`/`error-taxonomy` the native `RestClientV3`, surfaces the
   * `ExchangeAdapter` port deliberately doesn't expose generically.
   */
  readonly clients: BitgetClients
  readonly clock: Clock
  readonly bus: EventBus
  readonly events: readonly EngineEvent[]
  /**
   * The **committed** `config/exchanges.yaml` Bitget profile, as on Bybit/OKX — `deltas`/
   * `rate-limiter` assert the shipped numbers, and the adapter under test is built from it.
   */
  readonly profile: ExchangeProfile
  /** Free quote-asset balance — the fund-dependent checks' self-gate. */
  getBalanceFree(): Promise<number>
}

/**
 * Build the shared adapter/clients once; every check in the registry reuses this one context.
 *
 * Bitget demo trading, like OKX's, is a **flag** rather than a network: `network: 'testnet'`
 * sets `demoTrading: true` on the native clients and ccxt's `PAPTRADING` sandbox header on the
 * same REST host, and only the WS host differs (`wspap`), which the SDK owns. Demo serves the
 * ordinary `USDT-FUTURES` category (24 symbols, `BTCUSDT` among them), so no symbol or category
 * downstream is demo-specific.
 */
export async function createBitgetTestnetContext(): Promise<BitgetTestnetContext> {
  const hasCredentials = hasBitgetTestnetCredentials()
  const apiKey = process.env.BITGET_TESTNET_API_KEY ?? 'public'
  const apiSecret = process.env.BITGET_TESTNET_API_SECRET ?? 'public'
  // The factory fails loud on an absent passphrase, so the credential-free path supplies the
  // same placeholder as the other two — every credentialed check then skips on `hasCredentials`.
  const apiPassphrase = process.env.BITGET_TESTNET_PASSPHRASE ?? 'public'

  const clock = createRealClock()
  const bus = createEventBus()
  const events: EngineEvent[] = []
  bus.subscribe((e) => events.push(e))

  const profile = parseExchangeProfiles(readFileSync(EXCHANGES_YAML, 'utf8')).bitget
  const clients = createBitgetClients(profile, { apiKey, apiSecret, apiPassphrase }, { network: 'testnet' })
  const adapter = createBitgetAdapter({
    client: clients.ccxt,
    clock,
    limiter: createBitgetRateLimiter(profile, clock),
    accountSetup: clients.native,
    ws: clients.wsPublic,
    wsPublicKey: WS_KEY_MAP.v3Public,
    wsPrivate: clients.wsPrivate,
    wsPrivateKey: WS_KEY_MAP.v3Private,
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

// ── KuCoin (task 0460, LIVE read-only — there is no testnet) ─────────────────

/**
 * KuCoin signs with three credentials, as OKX and Bitget do — but the env names deliberately
 * **break** the other four venues' `<VENUE>_TESTNET_*` convention.
 *
 * There is no KuCoin futures testnet: the sandbox was decommissioned, ccxt carries no
 * `urls.test` for `kucoinfutures`, and `setSandboxMode(true)` silently empties `urls.api`
 * (`kucoin/factory.ts`). A `KUCOIN_TESTNET_API_KEY` line in a `.env` would therefore be a lie
 * about what the key is: it is a **live production key on an account with real money**. So the
 * names are the plain `KUCOIN_API_KEY` / `_API_SECRET` / `_API_PASSPHRASE` the engine itself
 * reads (`09` §2), and the fourth term — `KUCOIN_LIVE_READONLY=1` — is an explicit opt-in that
 * exists precisely *because* they are live keys: merely having KuCoin credentials in the
 * environment (for `npm start`) must not silently arm this suite against the live account.
 */
export function hasKucoinCredentials(): boolean {
  return (
    !!process.env.KUCOIN_API_KEY &&
    !!process.env.KUCOIN_API_SECRET &&
    !!process.env.KUCOIN_API_PASSPHRASE &&
    process.env.KUCOIN_LIVE_READONLY === '1'
  )
}

export interface KucoinLiveContext extends CheckContext {
  readonly adapter: ExchangeAdapter
  /**
   * Raw ccxt/native clients — `assert-flat` needs the account-wide open-order read, a surface
   * the `ExchangeAdapter` port deliberately doesn't expose generically. Note what the checks
   * never reach for: nothing here is used to *write*.
   */
  readonly clients: KucoinClients
  readonly clock: Clock
  readonly bus: EventBus
  readonly events: readonly EngineEvent[]
  /**
   * The **committed** `config/exchanges.yaml` KuCoin profile, as on the siblings — `deltas`/
   * `rate-limiter` assert the shipped numbers, and the adapter under test is built from it.
   */
  readonly profile: ExchangeProfile
  /**
   * Marker, not a flag: this venue's tier runs against **live production** with live keys, so
   * every check in `./kucoin/` is a read. Nothing branches on it — it is carried so a check (or
   * a future reader) cannot mistake this context for a sandbox one.
   */
  readonly readOnly: true
}

/**
 * Build the shared adapter/clients once; every check in the registry reuses this one context.
 *
 * Unlike the four siblings this takes **no `network` argument**, because `kucoin/factory.ts`
 * deliberately exposes none (see `hasKucoinCredentials` above). The order path is also left
 * unwired on purpose — no `wsApiPrivate`, no `restOrders`, no `accountSetup` — so a stray
 * `placeOrder`/`cancelOrder`/`setLeverage` in a check fails loud ("order path requires …")
 * instead of reaching a real account.
 */
export async function createKucoinTestnetContext(): Promise<KucoinLiveContext> {
  const hasCredentials = hasKucoinCredentials()
  const apiKey = process.env.KUCOIN_API_KEY ?? 'public'
  const apiSecret = process.env.KUCOIN_API_SECRET ?? 'public'
  // The factory fails loud on an absent passphrase, so the credential-free path supplies the
  // same placeholder as the other two — every credentialed check then skips on `hasCredentials`.
  const apiPassphrase = process.env.KUCOIN_API_PASSPHRASE ?? 'public'

  const clock = createRealClock()
  const bus = createEventBus()
  const events: EngineEvent[] = []
  bus.subscribe((e) => events.push(e))

  const profile = parseExchangeProfiles(readFileSync(EXCHANGES_YAML, 'utf8')).kucoin
  const clients = createKucoinClients(profile, { apiKey, apiSecret, apiPassphrase })
  const adapter = createKucoinAdapter({
    client: clients.ccxt,
    clock,
    limiter: createKucoinRateLimiter(profile, clock),
    ws: clients.wsPublic,
    wsPublicKey: KUCOIN_WS_KEY_MAP.futuresPublicV1,
    wsPrivate: clients.wsPrivate,
    wsPrivateKey: KUCOIN_WS_KEY_MAP.futuresPrivateV1,
    bus,
    submissionStaggerMs: profile.submissionStaggerMs,
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
    readOnly: true,
    onCleanup: () => {},
  }
}
