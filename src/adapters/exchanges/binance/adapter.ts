/**
 * Binance {@link ExchangeAdapter} — market metadata only (task 0190). `init()` loads
 * markets via ccxt, filters to active linear USDT perps, builds a validated
 * `Instrument` registry (fail-loud on any anomaly), reloads it hourly, and serves the
 * synchronous `markets()`/`normalize()` reads plus funding REST.
 *
 * Everything trade-side — orders, positions, balances, account setup, WS streams — is
 * a `NotImplemented` stub filled by 0200–0240. The taxonomy + rate limiter are 0200;
 * this file builds **no** error infra (KISS). Mirrors the sim's shape so the same core
 * trades against either venue behind the one port.
 */

import type { EventBus } from '../../../core/ports/bus.js'
import type { Clock, TimerHandle } from '../../../core/ports/clock.js'
import type {
  Balance,
  ExchangeAdapter,
  FundingEvent,
  FundingIncome,
  Instrument,
  MarginMode,
  Market,
  Order,
  OrderAck,
  OrderRequest,
  OrderStatus,
  Position,
  PositionMode,
  PrivateStream,
  PublicStream,
  Rate,
  TimeRange,
} from '../../../core/ports/exchange-adapter.js'
import { createOrderManager, type OrderManager } from '../../../execution/order-manager.js'
import type { ConsecutiveFailureCounter } from '../../shared/errors.js'
import { createConsecutiveFailureCounter, NotFoundError } from '../../shared/errors.js'
import type { RateLimiter } from '../../shared/rate-limiter.js'
import { type BinanceAccountSetup, createBinanceAccountSetup } from './account-setup.js'
import { mapBinanceError } from './error-map.js'
import type { BinanceMarketClient } from './factory.js'
import { buildInstrumentRegistry } from './instrument.js'
import { type BinancePrivateWsClient, createBinancePrivateStream } from './private-stream.js'
import { type BinanceWsClient, createBinancePublicStream, type TickerReading } from './public-stream.js'
import { type BinanceRestOrderClient, type BinanceWsOrderClient, createBinanceOrderTransport } from './ws-orders.js'

const HOUR_MS = 3_600_000

/**
 * General-lane weights (`10` §6) — real published Binance USDⓈ-M fapi request weights,
 * cross-checked against `ccxt.binanceusdm().describe().api.fapiPublic*`/`fapiPrivate*`
 * cost tables: `exchangeInfo`/`premiumIndex`/`fundingInfo`/`ticker24hr`(symbol)/`order`
 * query = 1; `account`/`positionRisk` (ccxt's v2 endpoints) = 1; `openOrders` with no
 * symbol (account-wide) = 40.
 */
const WEIGHT_LOAD_MARKETS = 1
const WEIGHT_FUNDING = 1
/** Bulk `premiumIndex` (no symbol) — same flat weight as the single-symbol read on USDⓈ-M. */
const WEIGHT_FUNDING_ALL = 1
/** `fapi/v1/fundingInfo` — per-symbol funding interval read (SUGGESTIONS L13). */
const WEIGHT_FUNDING_INFO = 1
/** Single-symbol ticker read — the tick REST fallback poll (weight 1, general lane). */
const WEIGHT_TICKER = 1
/** Account-read weights for the private-stream reprime + `getPositions`/`getBalance`/`getOrder` (0220). */
const WEIGHT_POSITIONS = 1
const WEIGHT_BALANCE = 1
const WEIGHT_OPEN_ORDERS = 40
const WEIGHT_GET_ORDER = 1
/** Account-setup writes (`setLeverage`/`setMarginMode`/`setPositionMode`) — general lane, weight 1. */
const WEIGHT_ACCOUNT_SETUP = 1

/**
 * Quote/settle asset for the linear USDT-perp universe (`10` §3). The account balance the
 * strategy sizes against is always this asset; the private stream's WS `BalanceUpdate`
 * carries every wallet asset, but the authoritative REST `getBalance` reports this one.
 */
const QUOTE_ASSET = 'USDT'

/** Everything the adapter needs, all injectable so unit tests run offline (`10` §2). */
export interface BinanceAdapterDeps {
  /** ccxt-backed market/funding client (`./factory.ts`); a fake in tests. */
  readonly client: BinanceMarketClient
  /** Time + timers — the only clock the reload loop reads (`08` §5). */
  readonly clock: Clock
  /** Canonical names to exclude from the universe (`config.symbols.deny`, `10` §3). */
  readonly deny?: readonly string[]
  /**
   * Weighted rate limiter (task 0200). When present, the three REST reads draw the
   * **general** lane and their throws map through {@link mapBinanceError}; when absent
   * the reads pass through raw (keeps 0190's offline unit tests unchanged). The order
   * lane is wired into `placeOrder`/`cancelOrder` at 0230.
   */
  readonly limiter?: RateLimiter
  /**
   * Native public market-data WS client (`factory.ts` `wsPublic`). When present with
   * {@link bus}, the public stream (0210) is fully wired; when absent, `streams.public.*`
   * throws a clear "requires ws+bus" error so 0190/0200 offline tests construct unaffected.
   */
  readonly ws?: BinanceWsClient
  /**
   * Native private user-data WS client (`factory.ts` `wsPrivate`, credentialed). When
   * present with {@link bus}, the private stream (0220) is fully wired; when absent,
   * `streams.private.*` throws a clear "requires wsPrivate+bus" error so the offline
   * unit tests construct unaffected.
   */
  readonly wsPrivate?: BinancePrivateWsClient
  /** Core event bus the public/private streams publish onto (`08` §4). Paired with {@link ws}/{@link wsPrivate}. */
  readonly bus?: EventBus
  /**
   * Native WS-API order client (`factory.ts` `wsApiPrivate`, credentialed). Present with
   * {@link restOrders} + {@link bus} → the WS-first order path (0230) is wired; absent any
   * of the three, `placeOrder`/`cancelOrder` fail loud (offline unit tests unaffected).
   */
  readonly wsApiPrivate?: BinanceWsOrderClient
  /** Native REST order client (`factory.ts` `native`, `USDMClient`) — the WS-timeout REST fallback (`11` §5). */
  readonly restOrders?: BinanceRestOrderClient
  /** Per-venue submission stagger, ms (`00_globals` §6; Binance 100). Threaded from the venue profile. */
  readonly submissionStaggerMs?: number
  /** Whether a WS-timeout falls back to REST (venue delta `ws_order_rest_fallback`; Binance `false`). */
  readonly wsOrderRestFallback?: boolean
  /** Shared breaker observer (0200): the order manager's fill-poll `getOrder` errors feed it. */
  readonly failures?: ConsecutiveFailureCounter
  /** Structured-log callback (`main.ts` wires `logger.warn`); no-op when absent (offline tests unaffected). */
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void
}

/** ccxt reports funding as a fraction (`0.0001`); the engine speaks signed percent (`0.01`). */
function toSignedPercent(fundingRate: number | undefined): number {
  return (fundingRate ?? 0) * 100
}

/** Placeholder public stream when `ws`/`bus` are not injected — every method fails loud. */
function unwiredPublicStream(): PublicStream {
  const fail = (): never => {
    throw new Error('BinanceAdapter: public stream requires ws+bus deps')
  }
  return {
    subscribe: fail,
    subscribeTicks: fail,
    unsubscribeTicks: fail,
    close: fail,
  }
}

/** Placeholder private stream when `wsPrivate`/`bus` are not injected — every method fails loud. */
function unwiredPrivateStream(): PrivateStream {
  const fail = (): never => {
    throw new Error('BinanceAdapter: private stream requires wsPrivate+bus deps')
  }
  return { subscribe: fail, close: fail }
}

export function createBinanceAdapter(deps: BinanceAdapterDeps): ExchangeAdapter {
  const { client, clock, limiter, ws, wsPrivate, bus, wsApiPrivate, restOrders } = deps
  const deny = deps.deny ?? []
  const failures = deps.failures ?? createConsecutiveFailureCounter()
  const log = deps.log ?? (() => {})

  // `clientOrderId → venueSymbol`, populated by the private stream's `ORDER_TRADE_UPDATE`
  // handler so `getOrder` can supply the symbol Binance REST requires. 0230 `placeOrder`
  // populates it authoritatively at submit time.
  const clientOrderIdToVenue = new Map<string, string>()

  /**
   * Run a general-lane REST read under the limiter, mapping any throw to a typed
   * {@link mapBinanceError} error. No limiter → passthrough (raw call, raw throw), so
   * the 0190 offline tests are unaffected.
   */
  async function callGeneral<T>(weight: number, fn: () => Promise<T>): Promise<T> {
    if (!limiter) return fn()
    await limiter.acquire(weight, 'general')
    try {
      const result = await fn()
      failures.recordSuccess() // a successful venue read closes/heals the circuit breaker (0380)
      return result
    } catch (err) {
      const mapped = mapErr(err)
      failures.record(mapped) // consecutive NetworkError/VenueUnavailable trips the breaker (0380)
      throw mapped
    }
  }

  /** Map a venue throw, logging an unmapped code so a wrong assumption about it is observable. */
  function mapErr(err: unknown): ReturnType<typeof mapBinanceError> {
    return mapBinanceError(err, { onUnknown: (rawCode) => log('binance: unmapped venue error code', { rawCode }) })
  }

  /**
   * Run an order-lane venue call: draw the reserved order lane (never starved by the
   * general poll, `10` §6) and map any throw to a typed {@link mapBinanceError}. Unlike
   * {@link callGeneral} it **always** maps (no limiter → still map), since the order
   * manager relies on seeing only {@link AdapterError}s; the order lane throws
   * `RateLimitedError` immediately when exhausted (no queue).
   */
  async function callOrder<T>(weight: number, fn: () => Promise<T>): Promise<T> {
    if (limiter) await limiter.acquire(weight, 'order')
    try {
      return await fn()
    } catch (err) {
      throw mapErr(err)
    }
  }

  // Swapped atomically on every (re)load — readers never see a half-built registry.
  let instruments = new Map<string, Instrument>()
  // Reverse index (venue id → canonical) for the public stream's per-message resolve —
  // O(1) instead of scanning `instruments` on every 1 s all-market mark-price array.
  let venueToNormalized = new Map<string, string>()
  let reloadHandle: TimerHandle | undefined

  /**
   * True per-symbol funding interval (`fapi/v1/fundingInfo`, SUGGESTIONS L13), keyed by
   * venue symbol. ccxt returns entries only for symbols whose interval differs from the
   * 8h default, so absent symbols fall back through `market.info`/8h in `instrument.ts`.
   */
  async function readFundingIntervals(): Promise<Map<string, number>> {
    const rates = await callGeneral(WEIGHT_FUNDING_INFO, () => client.fetchFundingIntervals())
    const out = new Map<string, number>()
    for (const fr of Object.values(rates)) {
      const info = fr.info as { symbol?: unknown; fundingIntervalHours?: unknown } | undefined
      const venue = typeof info?.symbol === 'string' ? info.symbol : undefined
      const hours = typeof info?.fundingIntervalHours === 'number' ? info.fundingIntervalHours : undefined
      if (venue !== undefined && hours !== undefined) out.set(venue, hours)
    }
    return out
  }

  /** Load + validate markets into a fresh registry, then swap the reference in. */
  async function reloadRegistry(): Promise<void> {
    const markets = await callGeneral(WEIGHT_LOAD_MARKETS, () => client.loadMarkets())
    const intervals = await readFundingIntervals()
    const next = buildInstrumentRegistry(Object.values(markets), deny, intervals, log)
    const reverse = new Map<string, string>()
    for (const inst of next.values()) reverse.set(inst.venueSymbol, inst.normalized)
    instruments = next
    venueToNormalized = reverse
  }

  /** Self-perpetuating hourly reload (mirrors `scheduler.ts:scheduleScan`). */
  function armReload(): void {
    reloadHandle = clock.scheduleTimer(clock.now() + HOUR_MS, () => {
      // Fire-and-forget: a transient reload failure keeps the last-good registry and
      // the next tick retries. Re-arm first so one rejected load never stops the loop.
      armReload()
      void reloadRegistry()
    })
  }

  /** Look up a validated instrument; fail loud on an unknown symbol (sim parity, `10` §4). */
  function normalize(symbol: string): Instrument {
    const instrument = instruments.get(symbol)
    if (!instrument) throw new Error(`BinanceAdapter: unknown symbol '${symbol}'`)
    return instrument
  }

  /** Resolve a normalized symbol to its exact venue string for a REST call. */
  function venueSymbol(symbol: string): string {
    return normalize(symbol).venueSymbol
  }

  /**
   * Cached ccxt account setup (`11` §1) backing the three port methods below. General-lane
   * + error-mapped like the other REST reads; the applied-state cache makes a repeat call a
   * no-op. The effective (delta-resolved) leverage arrives via the port method's `leverage`.
   */
  const accountSetup: BinanceAccountSetup = createBinanceAccountSetup({
    client,
    resolveVenue: venueSymbol,
    call: (fn) => callGeneral(WEIGHT_ACCOUNT_SETUP, fn),
  })

  /** Predicted-funding REST read — the `predictedFunding` method and the stream fallback share it. */
  async function readPredictedFunding(symbol: string): Promise<Rate> {
    const fr = await callGeneral(WEIGHT_FUNDING, () => client.fetchFundingRate(venueSymbol(symbol)))
    return { symbol, rate: toSignedPercent(fr.fundingRate), ts: fr.timestamp ?? clock.now() }
  }

  /**
   * Bulk predicted-funding REST read (all-symbol `premiumIndex`, SUGGESTIONS L21) —
   * collapses the public stream's fallback poll/reprime from N weight-1 per-symbol
   * calls into one. Keyed by venue symbol (raw); the stream resolves + gates each key
   * to its subscribed universe (`public-stream.ts` `resolveFunding`).
   */
  async function readAllPredictedFunding(): Promise<Map<string, Rate>> {
    const rates = await callGeneral(WEIGHT_FUNDING_ALL, () => client.fetchFundingRates())
    const out = new Map<string, Rate>()
    for (const fr of Object.values(rates)) {
      const info = fr.info as { symbol?: unknown } | undefined
      const venue = typeof info?.symbol === 'string' ? info.symbol : undefined
      if (venue === undefined) continue
      out.set(venue, { symbol: venue, rate: toSignedPercent(fr.fundingRate), ts: fr.timestamp ?? clock.now() })
    }
    return out
  }

  /** Last-price REST read for the public stream's tick fallback/reprime. */
  async function readTicker(symbol: string): Promise<TickerReading> {
    const ticker = await callGeneral(WEIGHT_TICKER, () => client.fetchTicker(venueSymbol(symbol)))
    const price = ticker.last ?? ticker.close
    if (price === undefined) throw new Error(`BinanceAdapter: ticker for '${symbol}' carries no last/close price`)
    return { price, ts: ticker.timestamp ?? clock.now() }
  }

  /**
   * Resolve a ccxt market's canonical name from its raw venue id (`info.symbol`, e.g.
   * `BTCUSDT`) via the reverse registry — ccxt's unified `symbol` (`BTC/USDT:USDT`) is not
   * a registry key. Returns `undefined` for an unknown symbol (dropped, never guessed).
   */
  function canonicalOfCcxt(info: unknown): string | undefined {
    const venue = typeof info === 'object' && info !== null ? (info as { symbol?: unknown }).symbol : undefined
    return typeof venue === 'string' ? venueToNormalized.get(venue) : undefined
  }

  /** Map a ccxt order status (+ filled qty) to the engine {@link OrderStatus} (`11` §6). */
  function ccxtOrderStatus(status: string | undefined, filled: number): OrderStatus {
    switch (status) {
      case 'closed':
        return 'FILLED'
      case 'canceled':
        return 'CANCELLED'
      case 'expired':
        return 'EXPIRED'
      case 'rejected':
        return 'REJECTED'
      default:
        // 'open' (and any unexpected value) → OPEN, or PARTIAL once partly filled.
        return filled > 0 ? 'PARTIAL' : 'OPEN'
    }
  }

  /** Map a ccxt order to the port {@link Order}; symbol resolves via the registry, else stays raw. */
  function toOrder(o: {
    clientOrderId?: string
    id?: string
    info?: unknown
    symbol?: string
    side?: string
    type?: string
    status?: string
    average?: number
    filled?: number
    reduceOnly?: boolean
    fee?: { cost?: number | null } | null
  }): Order {
    const filled = o.filled ?? 0
    // Binance reports `reduceOnly` on the ccxt order (unified flag or raw `info.reduceOnly`).
    const info = typeof o.info === 'object' && o.info !== null ? (o.info as { reduceOnly?: unknown }) : undefined
    const reduceOnly = o.reduceOnly === true || info?.reduceOnly === true || info?.reduceOnly === 'true'
    // Realized fill fee (quote ccy) for the reconciliation fills-dimension (`15` §2, 0400).
    const feeCost = o.fee?.cost
    return {
      clientOrderId: o.clientOrderId ?? '',
      ...(o.id ? { venueOrderId: o.id } : {}),
      symbol: canonicalOfCcxt(o.info) ?? o.symbol ?? '',
      side: o.side === 'sell' ? 'short' : 'long',
      type: o.type === 'limit' ? 'limit' : o.type === 'stop' ? 'stop' : 'market',
      status: ccxtOrderStatus(o.status, filled),
      ...(o.average !== undefined && o.average !== null ? { fillPx: o.average } : {}),
      ...(filled > 0 ? { qty: filled } : {}),
      ...(feeCost !== undefined && feeCost !== null ? { fee: feeCost } : {}),
      ...(reduceOnly ? { reduceOnly: true } : {}),
    }
  }

  /** Account-wide open positions (private-stream reprime + degraded poll, `11` §7). */
  async function readPositions(): Promise<Position[]> {
    const raw = await callGeneral(WEIGHT_POSITIONS, () => client.fetchPositions())
    const out: Position[] = []
    for (const p of raw) {
      const symbol = canonicalOfCcxt(p.info)
      if (symbol === undefined) continue
      const contracts = p.contracts ?? 0
      out.push({
        symbol,
        side: p.side === 'short' ? 'short' : 'long',
        qty: Math.abs(contracts),
        ...(p.entryPrice !== undefined && p.entryPrice !== null ? { entryPrice: p.entryPrice } : {}),
      })
    }
    return out
  }

  /** Authoritative quote-asset balance (free/used split) — reprime + preflight (`11` §7). */
  async function readBalance(): Promise<Balance> {
    const balances = await callGeneral(WEIGHT_BALANCE, () => client.fetchBalance())
    const quote = balances[QUOTE_ASSET]
    return { asset: QUOTE_ASSET, free: quote?.free ?? 0, used: quote?.used ?? 0 }
  }

  /** Account-wide open orders (private-stream reprime, `11` §7). */
  async function readOpenOrders(): Promise<Order[]> {
    const raw = await callGeneral(WEIGHT_OPEN_ORDERS, () => client.fetchOpenOrders())
    return raw.map((o) => toOrder(o))
  }

  /** Fill-poll one order by client id. Symbol comes from the stream-maintained map (`11` §6). */
  async function readOrder(clientOrderId: string): Promise<Order> {
    const venue = clientOrderIdToVenue.get(clientOrderId)
    if (venue === undefined) {
      throw new NotFoundError(`BinanceAdapter.getOrder: no known symbol for clientOrderId '${clientOrderId}'`)
    }
    const o = await callGeneral(WEIGHT_GET_ORDER, () => client.fetchOrder(clientOrderId, venue, { clientOrderId }))
    return toOrder(o)
  }

  /**
   * The public stream, wired only when both `ws` + `bus` are injected. Absent either,
   * every method throws a clear fail-loud error (the 0190/0200 offline tests never touch
   * streams, so their construction is unaffected).
   */
  const publicStream: PublicStream =
    ws && bus
      ? createBinancePublicStream({
          ws,
          bus,
          clock,
          resolveCanonical: (venue) => venueToNormalized.get(venue),
          resolveVenue: venueSymbol,
          restFundingAll: readAllPredictedFunding,
          restTicker: readTicker,
        })
      : unwiredPublicStream()

  /**
   * The private user-data stream, wired only when both `wsPrivate` + `bus` are injected.
   * Absent either, every method fails loud (offline tests never touch it, so their
   * construction is unaffected). It publishes onto the bus and re-primes via the shared
   * reconnect FSM using the adapter's own REST account reads.
   */
  const privateStream: PrivateStream =
    wsPrivate && bus
      ? createBinancePrivateStream({
          ws: wsPrivate,
          bus,
          clock,
          resolveCanonical: (venue) => venueToNormalized.get(venue),
          restPositions: readPositions,
          restBalance: readBalance,
          restOpenOrders: readOpenOrders,
          recordOrderSymbol: (clientOrderId, venue) => clientOrderIdToVenue.set(clientOrderId, venue),
        })
      : unwiredPrivateStream()

  /** Venue symbol for a known `clientOrderId` (cancel path); fail-loud if unseen. */
  function venueForClientId(clientOrderId: string): string {
    const venue = clientOrderIdToVenue.get(clientOrderId)
    if (venue === undefined) {
      throw new NotFoundError(`BinanceAdapter: no known symbol for clientOrderId '${clientOrderId}'`)
    }
    return venue
  }

  /**
   * The WS-first order manager, wired only when the WS-API order client, REST order
   * client, and bus are all injected. Absent any, `placeOrder`/`cancelOrder` fail loud
   * (offline unit tests never touch them). The transport records `clientOrderId →
   * venueSymbol` authoritatively at submit time — unblocking `getOrder`/`cancel`.
   */
  const orderManager: OrderManager | undefined =
    wsApiPrivate && restOrders && bus
      ? createOrderManager({
          transport: createBinanceOrderTransport({
            wsApi: wsApiPrivate,
            rest: restOrders,
            clock,
            resolveVenue: venueSymbol,
            recordVenue: (clientOrderId, venue) => clientOrderIdToVenue.set(clientOrderId, venue),
            venueForClientId,
            getOrder: readOrder,
            callOrder,
            log,
          }),
          clock,
          bus,
          resolveInstrument: normalize,
          staggerMs: deps.submissionStaggerMs ?? 0,
          wsOrderRestFallback: deps.wsOrderRestFallback ?? false,
          failures,
        })
      : undefined

  /** Fail loud when the order path is not wired (mirrors the unwired-stream placeholders). */
  function requireOrderManager(): OrderManager {
    if (!orderManager) {
      throw new Error('BinanceAdapter: order path requires wsApiPrivate + restOrders + bus deps')
    }
    return orderManager
  }

  return {
    // ── lifecycle ─────────────────────────────────────────────────────────────
    async init(): Promise<void> {
      await reloadRegistry() // fail-loud: a bad instrument aborts startup (`10` §3)
      armReload()
    },
    async close(): Promise<void> {
      reloadHandle?.cancel()
      reloadHandle = undefined
      orderManager?.dispose() // stop reacting to the bus (idempotent if never wired)
      if (ws && bus) await publicStream.close() // only the wired streams; the placeholders throw
      if (wsPrivate && bus) await privateStream.close()
    },

    // ── account setup (cached ccxt writes, set once in advance — `11` §1) ──────
    setLeverage(symbol: string, leverage: number): Promise<void> {
      return accountSetup.setLeverage(symbol, leverage)
    },
    setMarginMode(symbol: string, mode: MarginMode): Promise<void> {
      return accountSetup.setMarginMode(symbol, mode)
    },
    setPositionMode(mode: PositionMode): Promise<void> {
      return accountSetup.setPositionMode(mode)
    },

    // ── market metadata (synchronous reads off the cached registry) ───────────
    markets(): Market[] {
      return [...instruments.values()].map((i) => ({
        normalized: i.normalized,
        venueSymbol: i.venueSymbol,
        status: 'trading',
      }))
    },
    normalize,

    // ── orders (native WS-first, REST fallback — 0230) ────────────────────────
    placeOrder(req: OrderRequest): Promise<OrderAck> {
      return requireOrderManager().placeOrder(req)
    },
    cancelOrder(clientOrderId: string): Promise<void> {
      return requireOrderManager().cancelOrder(clientOrderId)
    },

    // ── account reads (ccxt REST — private-stream reprime + trackers/preflight) ─
    getOrder(clientOrderId: string): Promise<Order> {
      return readOrder(clientOrderId)
    },
    async getOpenOrders(symbol?: string): Promise<Order[]> {
      const open = await readOpenOrders()
      return symbol === undefined ? open : open.filter((o) => o.symbol === symbol)
    },
    getPositions(): Promise<Position[]> {
      return readPositions()
    },
    getBalance(): Promise<Balance> {
      return readBalance()
    },

    // ── funding (ccxt REST) ───────────────────────────────────────────────────
    predictedFunding(symbol: string): Promise<Rate> {
      return readPredictedFunding(symbol)
    },
    async fundingHistory(symbol: string, range: TimeRange): Promise<FundingEvent[]> {
      const rows = await callGeneral(WEIGHT_FUNDING, () =>
        client.fetchFundingRateHistory(venueSymbol(symbol), range.fromTs),
      )
      return rows
        .filter((r) => r.timestamp !== undefined && r.timestamp >= range.fromTs && r.timestamp <= range.toTs)
        .map((r) => ({ symbol, rate: toSignedPercent(r.fundingRate), settleTs: r.timestamp as number }))
    },
    fundingIncome(_symbol: string, _range: TimeRange): Promise<FundingIncome[]> {
      // NotImplemented stub (header convention). The funding gate is engine-wired in 0300,
      // but on the credential-free sim; the real ccxt income read (fetch income of type
      // `FUNDING_FEE`) is DEFERRED past 0300 because it is unverifiable without the
      // credential-gated testnet tier that 0300's sim-only DoD does not include (SUGGESTIONS).
      throw new Error('BinanceAdapter.fundingIncome: not implemented (real Binance read deferred past task 0300)')
    },

    // ── streams (native WS — 0210 public / 0220 private) ──────────────────────
    streams: {
      public: publicStream,
      private: privateStream,
    },
  } satisfies ExchangeAdapter
}
