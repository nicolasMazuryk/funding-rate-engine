/**
 * OKX {@link ExchangeAdapter} (task 0430) — venue three behind the one port, and the second
 * repeat of spec `10`'s central claim: adding a venue is one adapter and **zero** core
 * changes. Structurally a mirror of `../bybit/adapter.ts`: `init()` loads markets via ccxt,
 * filters to active linear USDT-settled swaps, builds a validated `Instrument` registry
 * (fail-loud on any anomaly), reloads it hourly, serves the synchronous `markets()`/
 * `normalize()` reads, the lane-wrapped REST reads, the WS-first order path and the two
 * native streams.
 *
 * OKX divergences from the Bybit sibling, all data or adapter-local mapping:
 *  - **two registry calls.** OKX ships no funding-interval field at all: the interval *is*
 *    `nextFundingTime − fundingTime` off `GET /api/v5/public/funding-rate`, so the registry
 *    load pairs `loadMarkets()` with one all-symbol `fetchFundingRates()` (`instId=ANY`) and
 *    feeds the derived intervals into `buildInstrumentRegistry`. Binance needs a second read
 *    too (`fapi/v1/fundingInfo`); Bybit does not.
 *  - **`contractSize ≠ 1` is the normal case.** OKX sizes in contracts with a per-instrument
 *    face value `ctVal` (`BTC-USDT-SWAP` = 0.01 BTC), so roughly half the universe carries a
 *    non-unit contract size where the two prior venues carry 1 for everything but their
 *    multiplier listings. `computeQty` already divides by it and the transport sends the
 *    result verbatim as `sz` — this venue is the first to actually exercise that path.
 *  - **the venue id is `info.instId`**, not `info.symbol`, so the reverse-registry resolve
 *    reads a different field than either sibling.
 *  - **`fundingIncome` is implemented for real** (account bills, funding-fee type `8`,
 *    `balChg` **positive = received**), as on Bybit and unlike Binance's stub. On this venue
 *    it is more than a safety net: the WS funding signal is an inferred cash-balance delta
 *    (`./private-stream.ts`), so the bills read is the money truth.
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
import { createOkxAccountSetup, type OkxAccountSetup, type OkxAccountSetupClient } from './account-setup.js'
import { toVenueClOrdId } from './client-order-id.js'
import { mapOkxError } from './error-map.js'
import type { OkxMarketClient } from './factory.js'
import { buildInstrumentRegistry, deriveFundingIntervalHours } from './instrument.js'
import { createOkxPrivateStream, type OkxPrivateWsClient } from './private-stream.js'
import { createOkxPublicStream, type OkxWsClient, type TickerReading } from './public-stream.js'
import { createOkxOrderTransport, type OkxRestOrderClient, type OkxWsOrderClient } from './ws-orders.js'

const HOUR_MS = 3_600_000

/**
 * General-lane weight (`10` §6). OKX has **no** request-weight model — the published caps are
 * per-request-count and per-endpoint (20 req/2 s per IP on a read endpoint, 60 orders/2 s per
 * instrument) — so one call costs one token on every lane and there is no per-endpoint table
 * to mirror. The single constant keeps the accounting explicit rather than sprinkling literal
 * `1`s through the reads.
 */
const WEIGHT_REQUEST = 1

/**
 * Quote/settle asset for the linear USDT-perp universe (`10` §3). The account balance the
 * strategy sizes against is always this asset; the private stream's WS `BalanceUpdate`
 * carries every currency, but the authoritative REST `getBalance` reports this one.
 */
const QUOTE_ASSET = 'USDT'

/** Instrument type filter on the account/bills reads — the universe is swaps only. */
const INST_TYPE = 'SWAP'

/** Account-bills type that carries funding settlement (`GET /api/v5/account/bills`). */
const FUNDING_FEE_BILL_TYPE = '8'

/** Everything the adapter needs, all injectable so unit tests run offline (`10` §2). */
export interface OkxAdapterDeps {
  /** ccxt-backed market/funding/account client (`./factory.ts`); a fake in tests. */
  readonly client: OkxMarketClient
  /** Time + timers — the only clock the reload loop reads (`08` §5). */
  readonly clock: Clock
  /** Canonical names to exclude from the universe (`config.symbols.deny`, `10` §3). */
  readonly deny?: readonly string[]
  /**
   * Weighted rate limiter (`10` §6). When present, the REST reads draw the **general** lane
   * and their throws map through {@link mapOkxError}; when absent the reads pass through raw
   * (keeps the offline unit tests simple). The order lane is drawn by the transport.
   */
  readonly limiter?: RateLimiter
  /** Native account-setup client (`factory.ts` `native`, `RestClient`). Absent → setup fails loud. */
  readonly accountSetup?: OkxAccountSetupClient
  /**
   * Native public market-data WS client (`factory.ts` `wsPublic`). When present with
   * {@link bus}, the public stream is fully wired; when absent, `streams.public.*` throws a
   * clear "requires ws+bus" error so offline tests construct unaffected.
   */
  readonly ws?: OkxWsClient
  /**
   * Native private account WS client (`factory.ts` `wsPrivate`, credentialed). When present
   * with {@link bus}, the private stream is fully wired; when absent, `streams.private.*`
   * fails loud.
   */
  readonly wsPrivate?: OkxPrivateWsClient
  /** Core event bus the public/private streams publish onto (`08` §4). Paired with {@link ws}/{@link wsPrivate}. */
  readonly bus?: EventBus
  /**
   * Native WS-API order client (`factory.ts` `wsApiPrivate`, credentialed). Present with
   * {@link restOrders} + {@link bus} → the WS-first order path is wired; absent any of the
   * three, `placeOrder`/`cancelOrder` fail loud (offline unit tests unaffected).
   */
  readonly wsApiPrivate?: OkxWsOrderClient
  /** Native REST order client (`factory.ts` `native`) — the WS-timeout REST fallback (`11` §5). */
  readonly restOrders?: OkxRestOrderClient
  /** Per-venue submission stagger, ms (`00_globals` §6; OKX 100). Threaded from the venue profile. */
  readonly submissionStaggerMs?: number
  /** Whether a WS-timeout falls back to REST (venue delta `ws_order_rest_fallback`). */
  readonly wsOrderRestFallback?: boolean
  /** Shared breaker observer (0200): the order manager's fill-poll `getOrder` errors feed it. */
  readonly failures?: ConsecutiveFailureCounter
  /** Structured-log callback (`main.ts` wires `logger.warn`); no-op when absent. */
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void
}

/** ccxt reports funding as a fraction (`0.0001`); the engine speaks signed percent (`0.01`). */
function toSignedPercent(fundingRate: number | undefined): number {
  return (fundingRate ?? 0) * 100
}

/** Parse an OKX numeric string field (the raw rows are all strings); `""` is not 0. */
function num(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** The raw `instId` a ccxt payload was built from — OKX's venue id field. */
function rawInstId(info: unknown): string | undefined {
  if (typeof info !== 'object' || info === null) return undefined
  const instId = (info as { instId?: unknown }).instId
  return typeof instId === 'string' ? instId : undefined
}

/** Placeholder public stream when `ws`/`bus` are not injected — every method fails loud. */
function unwiredPublicStream(): PublicStream {
  const fail = (): never => {
    throw new Error('OkxAdapter: public stream requires ws+bus deps')
  }
  return { subscribe: fail, subscribeTicks: fail, unsubscribeTicks: fail, close: fail }
}

/** Placeholder private stream when `wsPrivate`/`bus` are not injected — every method fails loud. */
function unwiredPrivateStream(): PrivateStream {
  const fail = (): never => {
    throw new Error('OkxAdapter: private stream requires wsPrivate+bus deps')
  }
  return { subscribe: fail, close: fail }
}

export function createOkxAdapter(deps: OkxAdapterDeps): ExchangeAdapter {
  const { client, clock, limiter, ws, wsPrivate, bus, wsApiPrivate, restOrders } = deps
  const deny = deps.deny ?? []
  const failures = deps.failures ?? createConsecutiveFailureCounter()
  const log = deps.log ?? (() => {})

  // `clientOrderId → instId`, populated authoritatively by the transport at submit time and
  // kept warm by the private stream's `orders` frames, so `getOrder`/`cancel` can supply the
  // instrument OKX requires.
  const clientOrderIdToVenue = new Map<string, string>()

  /**
   * Run a general-lane REST read under the limiter, mapping any throw to a typed
   * {@link mapOkxError} error. No limiter → passthrough (raw call, raw throw).
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
  function mapErr(err: unknown): ReturnType<typeof mapOkxError> {
    return mapOkxError(err, { onUnknown: (rawCode) => log('okx: unmapped venue error code', { rawCode }) })
  }

  /**
   * Run an order-lane venue call: draw the reserved order lane (never starved by the general
   * poll, `10` §6) and map any throw. Unlike {@link callGeneral} it **always** maps (no
   * limiter → still map), since the order manager relies on seeing only {@link AdapterError}s.
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
  // Reverse index (venue id → canonical) for the streams' per-message resolve — O(1) instead
  // of scanning `instruments` on every frame.
  let venueToNormalized = new Map<string, string>()
  /**
   * `instId → instIdCode`, the venue's **numeric** instrument id, read off the same market
   * load. OKX deprecated the string `instId` on the WS trade API in March 2026 and rejects a
   * submit without the code (`50014`), so the order transport needs this second index
   * (`./ws-orders.ts`). It is adapter-local on purpose: the core `Instrument` stays unchanged
   * (a venue quirk is data at the edge, `10` §4).
   */
  let venueToInstIdCode = new Map<string, number>()
  let reloadHandle: TimerHandle | undefined

  /**
   * `instId → fundingIntervalHours`, derived from one all-symbol funding-rate read. OKX
   * publishes no interval field, so the subtraction below *is* the interval; a row that
   * cannot yield one is simply absent and the registry falls back to the 8 h default (and
   * then validates it, `10` §4).
   */
  async function readFundingIntervals(): Promise<Map<string, number>> {
    const rates = await callGeneral(WEIGHT_REQUEST, () => client.fetchFundingRates())
    const intervals = new Map<string, number>()
    for (const rate of Object.values(rates)) {
      const info = (typeof rate.info === 'object' && rate.info !== null ? rate.info : {}) as Record<string, unknown>
      const instId = rawInstId(info)
      if (instId === undefined) continue
      const hours =
        deriveFundingIntervalHours(info.fundingTime, info.nextFundingTime) ??
        deriveFundingIntervalHours(rate.fundingTimestamp, rate.nextFundingTimestamp)
      if (hours !== undefined) intervals.set(instId, hours)
    }
    return intervals
  }

  /** Load + validate markets into a fresh registry, then swap the reference in. */
  async function reloadRegistry(): Promise<void> {
    const [markets, intervals] = await Promise.all([
      callGeneral(WEIGHT_REQUEST, () => client.loadMarkets()),
      readFundingIntervals(),
    ])
    const next = buildInstrumentRegistry(Object.values(markets), deny, intervals, log)
    const reverse = new Map<string, string>()
    for (const inst of next.values()) reverse.set(inst.venueSymbol, inst.normalized)
    const codes = new Map<string, number>()
    for (const market of Object.values(markets)) {
      const instId = rawInstId(market?.info)
      const code = num((market?.info as { instIdCode?: unknown } | undefined)?.instIdCode)
      if (instId !== undefined && code !== undefined && reverse.has(instId)) codes.set(instId, code)
    }
    instruments = next
    venueToNormalized = reverse
    venueToInstIdCode = codes
  }

  /** Self-perpetuating hourly reload (mirrors `scheduler.ts:scheduleScan`). */
  function armReload(): void {
    reloadHandle = clock.scheduleTimer(clock.now() + HOUR_MS, () => {
      // Fire-and-forget: a transient reload failure keeps the last-good registry and the next
      // tick retries. Re-arm first so one rejected load never stops the loop.
      armReload()
      void reloadRegistry()
    })
  }

  /** Look up a validated instrument; fail loud on an unknown symbol (sim parity, `10` §4). */
  function normalize(symbol: string): Instrument {
    const instrument = instruments.get(symbol)
    if (!instrument) throw new Error(`OkxAdapter: unknown symbol '${symbol}'`)
    return instrument
  }

  /** Resolve a normalized symbol to its exact `instId` for a REST call. */
  function venueSymbol(symbol: string): string {
    return normalize(symbol).venueSymbol
  }

  /**
   * Cached native account setup (`11` §1) backing the three port methods below. General-lane +
   * error-mapped like the other REST calls; the applied-state cache makes a repeat call a
   * no-op. Fails loud when the native client is not injected.
   */
  const accountSetup: OkxAccountSetup | undefined = deps.accountSetup
    ? createOkxAccountSetup({
        client: deps.accountSetup,
        resolveVenue: venueSymbol,
        call: (fn) => callGeneral(WEIGHT_REQUEST, fn),
        log,
      })
    : undefined

  function requireAccountSetup(): OkxAccountSetup {
    if (!accountSetup) throw new Error('OkxAdapter: account setup requires the accountSetup dep')
    return accountSetup
  }

  /** Predicted-funding REST read — the `predictedFunding` method and the stream fallback share it. */
  async function readPredictedFunding(symbol: string): Promise<Rate> {
    const fr = await callGeneral(WEIGHT_REQUEST, () => client.fetchFundingRate(venueSymbol(symbol)))
    return { symbol, rate: toSignedPercent(fr.fundingRate), ts: fr.timestamp ?? clock.now() }
  }

  /**
   * Bulk predicted-funding REST read — ccxt's `fetchFundingRates` hits
   * `GET /api/v5/public/funding-rate` with `instId=ANY`, so the public stream's fallback
   * poll/reprime is one call rather than N. Keyed by `instId` (raw); the stream resolves +
   * gates each key to its subscribed universe.
   */
  async function readAllPredictedFunding(): Promise<Map<string, Rate>> {
    const rates = await callGeneral(WEIGHT_REQUEST, () => client.fetchFundingRates())
    const out = new Map<string, Rate>()
    for (const fr of Object.values(rates)) {
      const venue = rawInstId(fr.info)
      if (venue === undefined) continue
      out.set(venue, { symbol: venue, rate: toSignedPercent(fr.fundingRate), ts: fr.timestamp ?? clock.now() })
    }
    return out
  }

  /** Last-price REST read for the public stream's tick fallback/reprime. */
  async function readTicker(symbol: string): Promise<TickerReading> {
    const ticker = await callGeneral(WEIGHT_REQUEST, () => client.fetchTicker(venueSymbol(symbol)))
    const price = ticker.last ?? ticker.close
    if (price === undefined) throw new Error(`OkxAdapter: ticker for '${symbol}' carries no last/close price`)
    return { price, ts: ticker.timestamp ?? clock.now() }
  }

  /**
   * Resolve a ccxt payload's canonical name from its raw venue id (`info.instId`, e.g.
   * `BTC-USDT-SWAP`) via the reverse registry — ccxt's unified `symbol` (`BTC/USDT:USDT`) is
   * not a registry key. Returns `undefined` for an unknown symbol (dropped, never guessed).
   */
  function canonicalOfCcxt(info: unknown): string | undefined {
    const venue = rawInstId(info)
    return venue === undefined ? undefined : venueToNormalized.get(venue)
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
    // OKX reports `reduceOnly` as the string `"true"` on the raw row; ccxt surfaces the
    // unified boolean when it can parse it.
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
    const raw = await callGeneral(WEIGHT_REQUEST, () => client.fetchPositions(undefined, { instType: INST_TYPE }))
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
    const balances = await callGeneral(WEIGHT_REQUEST, () => client.fetchBalance())
    const quote = balances[QUOTE_ASSET]
    return { asset: QUOTE_ASSET, free: quote?.free ?? 0, used: quote?.used ?? 0 }
  }

  /** Account-wide open orders (private-stream reprime + the stale reduce-only sweep, `11` §7). */
  async function readOpenOrders(): Promise<Order[]> {
    const raw = await callGeneral(WEIGHT_REQUEST, () =>
      client.fetchOpenOrders(undefined, undefined, undefined, { instType: INST_TYPE }),
    )
    return raw.map((o) => toOrder(o))
  }

  /**
   * Fill-poll one order by client id (`11` §6). Unlike Bybit, ccxt's OKX `fetchOrder` takes
   * the client id directly (`{ clOrdId }` → `GET /api/v5/trade/order`) — but it also demands
   * the instrument, which comes from the submit-time map. The id is re-spelled on the way out
   * and the venue's echo re-spelled back, so the caller only ever sees the engine's own key.
   */
  async function readOrder(clientOrderId: string): Promise<Order> {
    const venue = clientOrderIdToVenue.get(clientOrderId)
    if (venue === undefined) {
      throw new NotFoundError(`OkxAdapter.getOrder: no known symbol for clientOrderId '${clientOrderId}'`)
    }
    const row = await callGeneral(WEIGHT_REQUEST, () =>
      client.fetchOrder('', venue, { clOrdId: toVenueClOrdId(clientOrderId) }),
    )
    if (row === undefined || row === null) {
      throw new NotFoundError(`OkxAdapter.getOrder: order '${clientOrderId}' not found on '${venue}'`)
    }
    return { ...toOrder(row), clientOrderId }
  }

  /**
   * The public stream, wired only when both `ws` + `bus` are injected. Absent either, every
   * method throws a clear fail-loud error (offline tests never touch streams, so their
   * construction is unaffected).
   */
  const publicStream: PublicStream =
    ws && bus
      ? createOkxPublicStream({
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
   * The private account stream, wired only when both `wsPrivate` + `bus` are injected. It
   * publishes onto the bus and re-primes via the shared reconnect FSM using the adapter's own
   * REST account reads.
   */
  const privateStream: PrivateStream =
    wsPrivate && bus
      ? createOkxPrivateStream({
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

  /** `instId` for a known `clientOrderId` (cancel path); fail-loud if unseen. */
  function venueForClientId(clientOrderId: string): string {
    const venue = clientOrderIdToVenue.get(clientOrderId)
    if (venue === undefined) {
      throw new NotFoundError(`OkxAdapter: no known symbol for clientOrderId '${clientOrderId}'`)
    }
    return venue
  }

  /**
   * The WS-first order manager, wired only when the WS-API order client, REST order client and
   * bus are all injected. Absent any, `placeOrder`/`cancelOrder` fail loud. The transport
   * records `clientOrderId → instId` authoritatively at submit time — unblocking
   * `getOrder`/`cancel`.
   */
  const orderManager: OrderManager | undefined =
    wsApiPrivate && restOrders && bus
      ? createOrderManager({
          transport: createOkxOrderTransport({
            wsApi: wsApiPrivate,
            rest: restOrders,
            clock,
            resolveVenue: venueSymbol,
            recordVenue: (clientOrderId, venue) => clientOrderIdToVenue.set(clientOrderId, venue),
            venueForClientId,
            resolveInstIdCode: (venue) => venueToInstIdCode.get(venue),
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
      throw new Error('OkxAdapter: order path requires wsApiPrivate + restOrders + bus deps')
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

    // ── account setup (cached native writes, set once in advance — `11` §1) ────
    setLeverage(symbol: string, leverage: number): Promise<void> {
      return requireAccountSetup().setLeverage(symbol, leverage)
    },
    setMarginMode(symbol: string, mode: MarginMode): Promise<void> {
      return requireAccountSetup().setMarginMode(symbol, mode)
    },
    setPositionMode(mode: PositionMode): Promise<void> {
      return requireAccountSetup().setPositionMode(mode)
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

    // ── orders (native WS-first, REST fallback) ───────────────────────────────
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
      const rows = await callGeneral(WEIGHT_REQUEST, () =>
        client.fetchFundingRateHistory(venueSymbol(symbol), range.fromTs),
      )
      return rows
        .filter((r) => r.timestamp !== undefined && r.timestamp >= range.fromTs && r.timestamp <= range.toTs)
        .map((r) => ({ symbol, rate: toSignedPercent(r.fundingRate), settleTs: r.timestamp as number }))
    },
    /**
     * Account funding-income credits (`00_globals.md` §6 REST safety net) off the account
     * bills: `type=8` rows carry the settlement in `balChg`, the signed change to the account
     * balance, so **positive = received** with no negation. Filtered to this instrument and
     * the range, since OKX pages the bills account-wide — and re-checked client-side because
     * ccxt drops `since` on this call.
     *
     * The bill **type** is deliberately not sent as a param: `type` is ccxt's own reserved
     * key for the *market* type, so passing OKX's `type=8` there lands on the wire as
     * `instType=8` and the venue answers `51000 "Parameter instType error"` (observed live,
     * task 0430). The row filter below is the type gate instead.
     */
    async fundingIncome(symbol: string, range: TimeRange): Promise<FundingIncome[]> {
      const venue = venueSymbol(symbol)
      const rows = await callGeneral(WEIGHT_REQUEST, () =>
        client.fetchLedger(QUOTE_ASSET, range.fromTs, undefined, {
          instType: INST_TYPE,
          instId: venue,
          begin: String(range.fromTs),
          end: String(range.toTs),
        }),
      )
      const out: FundingIncome[] = []
      for (const row of rows) {
        const info = (typeof row.info === 'object' && row.info !== null ? row.info : {}) as Record<string, unknown>
        if (typeof info.type === 'string' && info.type !== FUNDING_FEE_BILL_TYPE) continue
        if (typeof info.instId === 'string' && info.instId !== venue) continue
        const amount = num(info.balChg)
        if (amount === undefined || amount === 0) continue
        const fundingTime = row.timestamp ?? num(info.ts)
        if (fundingTime === undefined || fundingTime < range.fromTs || fundingTime > range.toTs) continue
        out.push({ symbol, amount, fundingTime })
      }
      return out
    },

    // ── streams (native WS) ───────────────────────────────────────────────────
    streams: {
      public: publicStream,
      private: privateStream,
    },
  } satisfies ExchangeAdapter
}
