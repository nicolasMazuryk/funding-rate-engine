/**
 * Live-tier check context (task 0470 phase 4) — the fourth verification layer's composition
 * root. Real venue, real keys, real money, adapter-level only (no Postgres, no engine boot;
 * that is 0480).
 *
 * Three things make it different from `src/testnet/context.ts`, which it otherwise mirrors
 * venue for venue:
 *
 *  1. **Credentials come from the gitignored sub-account registry**, not the environment
 *     (`src/config/subaccounts.ts`) — one `(exchange, strategy)` row, resolved by the CLI's
 *     required `--subaccount`, so a run can never be pointed at "whatever keys are in `.env`".
 *  2. **The adapter is capped before anyone sees it.** `withNotionalCap` wraps the port object
 *     inside this file and the raw handle is never returned, so no check — and no future
 *     caller — can route an uncapped order to the venue.
 *  3. **The context is venue-generic.** The testnet tier kept one context type per venue
 *     because its checks reach into raw venue clients; the live checks do not — they speak the
 *     `ExchangeAdapter` port plus the venue-native cancel sweep (`./sweep.ts`), both of which
 *     are already uniform. One context, one check set, five builders: the per-venue difference
 *     is data (`VENUE_BUILDERS`), not a type.
 *
 * Every builder uses the **live** profile from `config/exchanges.yaml` with no
 * testnet/demo flag — each factory defaults to `network: 'prod'`, so live is the absence of
 * the sandbox argument, never a separate host list.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { WS_KEY_MAP } from 'bitget-api'
import { WS_KEY_MAP as KUCOIN_WS_KEY_MAP } from 'kucoin-api'
import { createRealClock } from '../adapters/clock/real-clock.js'
import { createBinanceAdapter } from '../adapters/exchanges/binance/adapter.js'
import { createBinanceClients, createBinanceRateLimiter } from '../adapters/exchanges/binance/factory.js'
import { createBitgetAdapter } from '../adapters/exchanges/bitget/adapter.js'
import { createBitgetClients, createBitgetRateLimiter } from '../adapters/exchanges/bitget/factory.js'
import { createBybitAdapter } from '../adapters/exchanges/bybit/adapter.js'
import { createBybitClients, createBybitRateLimiter } from '../adapters/exchanges/bybit/factory.js'
import { createKucoinAdapter } from '../adapters/exchanges/kucoin/adapter.js'
import {
  createKucoinClients,
  createKucoinRateLimiter,
  type KucoinClients,
} from '../adapters/exchanges/kucoin/factory.js'
import type { KucoinOrderReply, KucoinWsOrderClient } from '../adapters/exchanges/kucoin/ws-orders.js'
import { createOkxAdapter } from '../adapters/exchanges/okx/adapter.js'
import { createOkxClients, createOkxRateLimiter } from '../adapters/exchanges/okx/factory.js'
import type { StrategyId } from '../config/canonical.js'
import { type ExchangeId, type ExchangeProfile, parseExchangeProfiles } from '../config/exchange-schema.js'
import { loadSubaccount, type SubaccountRow, type SubaccountSecrets } from '../config/subaccounts.js'
import { createEventBus } from '../core/events/bus.js'
import type { EngineEvent } from '../core/events/types.js'
import type { EventBus } from '../core/ports/bus.js'
import type { Clock } from '../core/ports/clock.js'
import type { ExchangeAdapter } from '../core/ports/exchange-adapter.js'
import type { PositionTracker } from '../execution/position-tracker.js'
import { createTraceFile } from '../replay/trace-file.js'
import type { CheckContext } from '../testnet/types.js'
import { createBinanceCancelSweep } from './binance/cancel-sweep.js'
import { createBitgetCancelSweep } from './bitget/cancel-sweep.js'
import { createBybitCancelSweep } from './bybit/cancel-sweep.js'
import { type LiveCaps, type LiveSuite, resolveCaps } from './caps.js'
import { createKucoinCancelSweep } from './kucoin/cancel-sweep.js'
import { type CappedAdapter, withNotionalCap } from './notional-cap.js'
import { createOkxCancelSweep } from './okx/cancel-sweep.js'
import type { PreflightReport } from './preflight.js'
import type { CancelSweep } from './sweep.js'
import { createTeardown, type Teardown, type TeardownReport } from './teardown.js'

/** Bumped whenever the live check registry or verdict shape changes in a way worth tracking. */
export const LIVE_TOOL_VERSION = '1'

/** Committed venue profiles — the live run is built from the same file the engine boots from. */
const EXCHANGES_YAML = 'config/exchanges.yaml'

/** Every sub-account in the registry is quote-denominated in USDT (`config/subaccounts.yaml`). */
export const LIVE_QUOTE_ASSET = 'USDT'

/** Structured log sink; the CLI passes one through so cap/preflight/teardown warnings surface. */
export type LiveLog = (message: string, meta?: Record<string, unknown>) => void

/** The slice of ccxt the live checks need beyond the port: a last-price read for the order band. */
export interface LiveTickerClient {
  fetchTicker(symbol: string): Promise<{ readonly last?: number | undefined; readonly close?: number | undefined }>
}

/** What one venue's builder produces. Uniform across the five — the difference is inside. */
interface VenueHandles {
  readonly adapter: ExchangeAdapter
  readonly cancelSweep: CancelSweep
  readonly ticker: LiveTickerClient
}

interface BuildArgs {
  readonly profile: ExchangeProfile
  readonly secrets: SubaccountSecrets
  readonly clock: Clock
  readonly bus: EventBus
  readonly log: LiveLog
}

/**
 * Mutable state shared across the checks of one run. The runner gives each check a fresh
 * `onCleanup` but the same context object, which is how `order-lifecycle` hands its picked
 * symbol to `cap-rejection` and how every post-preflight check learns whether it is allowed
 * to place an order at all.
 */
export interface LiveRunState {
  /** Set by the `subaccount-preflight` check; every later check refuses to trade without an `ok` one. */
  preflight?: PreflightReport
  /** The symbol the run's first order-placing check picked, reused by every later check. */
  symbol?: import('./symbol-pick.js').PickedSymbol
  /** Realized fees observed by the checks, USD — the verdict compares this to the suite bound. */
  feesUsd: number
  /** The entry fill `fill-test` produced, read by the tracking and close checks (phase 6). */
  fill?: LiveFill
  /**
   * The settlement `funding-test` is timed against, epoch ms UTC — chosen by `funding-window`
   * before the entry exists, so the entry and the wait agree on which `T_settle` they mean.
   */
  settleTs?: number
  /**
   * Signed funding the venue really credited (+) or charged (−) the held position, USD — the
   * money `funding-test` exists to observe (phase 7). Not a fee: it is not measured against the
   * suite's fee bound, since its sign and size are the market's, not the harness's.
   */
  fundingUsd?: number
  /** Built by the first check that needs it (`./checks/position.ts`); disposed by {@link LiveContext.close}. */
  positionTracker?: PositionTracker
  /** The teardown report, once `assert-flat` (or the CLI's `finally`) has produced one. */
  teardown?: TeardownReport
}

/** What one real entry fill cost and produced — the money truth `fill-test` asserts (`15` §2). */
export interface LiveFill {
  readonly symbol: string
  /** Filled quantity as the venue reported it, base units. */
  readonly qty: number
  /** Fill-weighted average fill price, quote currency. */
  readonly fillPx: number
  /** Realized fee the venue charged for this fill, USD (positive cost). */
  readonly feeUsd: number
}

/** What every live check receives. Venue-generic by construction — see the file header. */
export interface LiveContext extends CheckContext {
  readonly venue: ExchangeId
  readonly suite: LiveSuite
  /** Capped adapter. There is no accessor for the raw one, deliberately. */
  readonly adapter: CappedAdapter
  readonly clock: Clock
  readonly bus: EventBus
  readonly events: readonly EngineEvent[]
  readonly profile: ExchangeProfile
  /** Secret-free registry row — safe to serialize into the verdict. */
  readonly subaccount: SubaccountRow
  readonly caps: LiveCaps
  readonly teardown: Teardown
  readonly state: LiveRunState
  /** JSONL trace of every bus event this run published (`docs/trace-format.md`). */
  readonly tracePath: string
  readonly log: LiveLog
  /** Last traded price for a normalized symbol, quote currency. */
  lastPrice(symbol: string): Promise<number>
  /** Close sockets/timers and the trace file. */
  close(): Promise<void>
}

// ── Venue builders ───────────────────────────────────────────────────────────
//
// One entry per venue, each the *live* twin of that venue's `src/testnet/context.ts` builder:
// same clients, same adapter deps, minus the sandbox argument. KuCoin is the one that gains
// wiring rather than losing it — its read-only testnet tier (0460) deliberately left the order
// path unwired, and this tier owns its sub-account, so `restOrders`/`wsApiPrivate`/
// `accountSetup` are connected here for the first time.

/**
 * Narrow the native KuCoin WS-API client to the order surface the adapter's transport declares
 * (`kucoin/ws-orders.ts`). The SDK types `cancelFuturesOrder`'s `data` as a union covering the
 * batch endpoints (`{cancelledOrderIds}` | `{clientOid}`), which does not structurally satisfy
 * the single-order `KucoinOrderResult` — so the reply is narrowed here, at the composition
 * root, rather than by widening the adapter's contract for every caller. This wiring exists
 * only in the live tier: the 0460 read-only tier deliberately left KuCoin's order path unwired,
 * which is why this is the venue's first real order (`docs/plan/STATUS.md` `[high]`).
 */
function kucoinWsOrderClient(wsApi: KucoinClients['wsApiPrivate']): KucoinWsOrderClient {
  type SdkOrder = Parameters<KucoinClients['wsApiPrivate']['submitFuturesOrder']>[0]
  return {
    submitFuturesOrder: async (params) =>
      (await wsApi.submitFuturesOrder(params as unknown as SdkOrder)) as unknown as KucoinOrderReply,
    cancelFuturesOrder: async (params) => (await wsApi.cancelFuturesOrder(params)) as unknown as KucoinOrderReply,
  }
}

const VENUE_BUILDERS: Record<ExchangeId, (args: BuildArgs) => VenueHandles> = {
  binance: ({ profile, secrets, clock, bus, log }) => {
    const clients = createBinanceClients(profile, secrets)
    return {
      adapter: createBinanceAdapter({
        client: clients.ccxt,
        clock,
        limiter: createBinanceRateLimiter(profile, clock),
        ws: clients.wsPublic,
        wsPrivate: clients.wsPrivate,
        wsApiPrivate: clients.wsApiPrivate,
        restOrders: clients.native,
        bus,
        submissionStaggerMs: profile.submissionStaggerMs,
        wsOrderRestFallback: profile.deltas.wsOrderRestFallback ?? false,
        log,
      }),
      cancelSweep: createBinanceCancelSweep(clients),
      ticker: clients.ccxt,
    }
  },
  bybit: ({ profile, secrets, clock, bus, log }) => {
    const clients = createBybitClients(profile, secrets)
    return {
      adapter: createBybitAdapter({
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
        log,
      }),
      cancelSweep: createBybitCancelSweep(clients),
      ticker: clients.ccxt,
    }
  },
  okx: ({ profile, secrets, clock, bus, log }) => {
    const clients = createOkxClients(profile, secrets)
    return {
      adapter: createOkxAdapter({
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
        log,
      }),
      cancelSweep: createOkxCancelSweep(clients),
      ticker: clients.ccxt,
    }
  },
  bitget: ({ profile, secrets, clock, bus, log }) => {
    const clients = createBitgetClients(profile, secrets)
    return {
      adapter: createBitgetAdapter({
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
        log,
      }),
      cancelSweep: createBitgetCancelSweep(clients),
      ticker: clients.ccxt,
    }
  },
  kucoin: ({ profile, secrets, clock, bus, log }) => {
    const clients = createKucoinClients(profile, secrets)
    return {
      adapter: createKucoinAdapter({
        client: clients.ccxt,
        clock,
        limiter: createKucoinRateLimiter(profile, clock),
        accountSetup: clients.native,
        ws: clients.wsPublic,
        wsPublicKey: KUCOIN_WS_KEY_MAP.futuresPublicV1,
        wsPrivate: clients.wsPrivate,
        wsPrivateKey: KUCOIN_WS_KEY_MAP.futuresPrivateV1,
        wsApiPrivate: kucoinWsOrderClient(clients.wsApiPrivate),
        restOrders: clients.native,
        bus,
        submissionStaggerMs: profile.submissionStaggerMs,
        wsOrderRestFallback: profile.deltas.wsOrderRestFallback ?? false,
        log,
      }),
      cancelSweep: createKucoinCancelSweep(clients),
      ticker: clients.ccxt,
    }
  },
}

export interface CreateLiveContextOptions {
  /** Which sub-account to trade — the CLI's required `--subaccount` (`config/subaccounts.yaml`). */
  readonly strategy: StrategyId
  readonly suite: LiveSuite
  /** Clamps **down** from the compiled-in ceilings only (`./caps.ts`). */
  readonly caps?: LiveCaps
  readonly tracePath: string
  /** Override the config directory (tests); defaults to `<cwd>/config`. */
  readonly configDir?: string
  readonly log?: LiveLog
}

/**
 * Build the one context a live run shares across its checks: registry credentials → venue
 * clients → adapter → **cap wrapper** → teardown. Fails loud before any network call when the
 * sub-account row, its credentials, or the venue profile are missing or inactive.
 */
export async function createLiveContext(venue: ExchangeId, options: CreateLiveContextOptions): Promise<LiveContext> {
  const log: LiveLog = options.log ?? (() => {})
  const caps = options.caps ?? resolveCaps()
  const subaccountRow = loadSubaccount({
    exchange: venue,
    strategy: options.strategy,
    ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
  })
  const profile = parseExchangeProfiles(readFileSync(EXCHANGES_YAML, 'utf8'))[venue]

  const clock = createRealClock()
  const bus = createEventBus()
  const events: EngineEvent[] = []
  // The trace writer opens the file directly, so its (gitignored) directory has to exist first.
  mkdirSync(dirname(options.tracePath), { recursive: true })
  const trace = createTraceFile({ path: options.tracePath })
  bus.subscribe((e) => {
    events.push(e)
    trace.recordEvent(e, clock.now())
  })

  const handles = VENUE_BUILDERS[venue]({ profile, secrets: subaccountRow.secrets, clock, bus, log })
  // Capped from here on. `handles.adapter` is not exposed on the context, so the only
  // `placeOrder` any check can reach is the wrapped one.
  const adapter = withNotionalCap(handles.adapter, { caps, bus, clock, log })
  await adapter.init()

  // Teardown flattens *through* the cap wrapper — its closes are reduce-only, which the
  // wrapper exempts, so a position larger than the cap can always be closed.
  const teardown = createTeardown({ exchange: adapter, cancelSweep: handles.cancelSweep, clock, bus, log })

  // Held by name so `close()` can dispose whatever the checks parked on it (the position
  // tracker owns a clock timer and a bus subscription that would otherwise keep the CLI alive).
  const state: LiveRunState = { feesUsd: 0 }

  return {
    hasCredentials: true,
    venue,
    suite: options.suite,
    adapter,
    clock,
    bus,
    events,
    profile,
    subaccount: subaccountRow.toJSON(),
    caps,
    teardown,
    state,
    tracePath: options.tracePath,
    log,
    async lastPrice(symbol: string): Promise<number> {
      const ticker = await handles.ticker.fetchTicker(adapter.normalize(symbol).venueSymbol)
      const price = ticker.last ?? ticker.close
      if (price === undefined || !Number.isFinite(price) || price <= 0) {
        throw new Error(`[live] no usable last price for '${symbol}' on ${venue}: ${String(price)}`)
      }
      return price
    },
    async close(): Promise<void> {
      try {
        state.positionTracker?.dispose()
        await adapter.close()
      } finally {
        trace.close()
      }
    },
    onCleanup: () => {},
  }
}
