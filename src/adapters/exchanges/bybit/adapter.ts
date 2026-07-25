/**
 * Bybit {@link ExchangeAdapter} (task 0420) — the second real venue behind the one port, and
 * the proof of spec `10`'s central claim: adding a venue is one adapter and **zero** core
 * changes. Structurally a mirror of `../binance/adapter.ts`: `init()` loads markets via ccxt,
 * filters to active linear USDT perps, builds a validated `Instrument` registry (fail-loud on
 * any anomaly), reloads it hourly, serves the synchronous `markets()`/`normalize()` reads,
 * the lane-wrapped REST reads, the WS-first order path and the two native streams.
 *
 * Bybit divergences from the Binance sibling, all data or adapter-local mapping:
 *  - **one registry call**: the funding interval ships inside `market.info.fundingInterval`
 *    (minutes), so there is no `fapi/v1/fundingInfo` analogue to read;
 *  - **flat weights**: Bybit publishes no weight model, so every REST read costs 1 token —
 *    the profile's 6000/min budget is what makes the reserved order lane equal the venue's
 *    real 10 orders/s cap (see `config/exchanges.yaml` and `factory.ts`);
 *  - **`getOrder` by `orderLinkId`**: ccxt's `fetchOrder` hard-binds the venue `orderId`, so
 *    the client-id read goes through `fetchOpenOrders(symbol, …, { orderLinkId })`, which hits
 *    `/v5/order/realtime` — open **and** recently-closed orders, i.e. exactly the fill-poll
 *    window (`11` §6);
 *  - **`fundingIncome` is implemented for real** (`fetchLedger` → transaction-log
 *    `SETTLEMENT`, `info.funding`, positive = received), where Binance still stubs it. This is
 *    the funding gate's REST safety net (`00_globals.md` §6, task 0290) and is
 *    testnet-verifiable on this venue.
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
import { type BybitAccountSetup, type BybitAccountSetupClient, createBybitAccountSetup } from './account-setup.js'
import { mapBybitError } from './error-map.js'
import type { BybitMarketClient } from './factory.js'
import { buildInstrumentRegistry } from './instrument.js'
import { type BybitPrivateWsClient, createBybitPrivateStream } from './private-stream.js'
import { type BybitWsClient, createBybitPublicStream, type TickerReading } from './public-stream.js'
import { type BybitRestOrderClient, type BybitWsOrderClient, createBybitOrderTransport } from './ws-orders.js'

const HOUR_MS = 3_600_000

/**
 * General-lane weight (`10` §6). Bybit has **no** request-weight model — the published caps
 * are per-request-count (600 req/5 s per IP, 10 orders/s per UID) — so one call costs one
 * token on every lane and there is no per-endpoint table to mirror. The single constant keeps
 * the accounting explicit rather than sprinkling literal `1`s through the reads.
 */
const WEIGHT_REQUEST = 1

/**
 * Quote/settle asset for the linear USDT-perp universe (`10` §3). The account balance the
 * strategy sizes against is always this asset; the private stream's WS `BalanceUpdate` carries
 * every wallet coin, but the authoritative REST `getBalance` reports this one.
 */
const QUOTE_ASSET = 'USDT'

/** Transaction-log row type that carries funding settlement (`/v5/account/transaction-log`). */
const SETTLEMENT_TYPE = 'SETTLEMENT'

/** Everything the adapter needs, all injectable so unit tests run offline (`10` §2). */
export interface BybitAdapterDeps {
  /** ccxt-backed market/funding/account client (`./factory.ts`); a fake in tests. */
  readonly client: BybitMarketClient
  /** Time + timers — the only clock the reload loop reads (`08` §5). */
  readonly clock: Clock
  /** Canonical names to exclude from the universe (`config.symbols.deny`, `10` §3). */
  readonly deny?: readonly string[]
  /**
   * Weighted rate limiter (`10` §6). When present, the REST reads draw the **general** lane
   * and their throws map through {@link mapBybitError}; when absent the reads pass through raw
   * (keeps the offline unit tests simple). The order lane is drawn by the transport.
   */
  readonly limiter?: RateLimiter
  /** Native account-setup client (`factory.ts` `native`, `RestClientV5`). Absent → setup fails loud. */
  readonly accountSetup?: BybitAccountSetupClient
  /**
   * Native public market-data WS client (`factory.ts` `wsPublic`). When present with
   * {@link bus}, the public stream is fully wired; when absent, `streams.public.*` throws a
   * clear "requires ws+bus" error so offline tests construct unaffected.
   */
  readonly ws?: BybitWsClient
  /**
   * Native private account WS client (`factory.ts` `wsPrivate`, credentialed). When present
   * with {@link bus}, the private stream is fully wired; when absent, `streams.private.*`
   * fails loud.
   */
  readonly wsPrivate?: BybitPrivateWsClient
  /** Core event bus the public/private streams publish onto (`08` §4). Paired with {@link ws}/{@link wsPrivate}. */
  readonly bus?: EventBus
  /**
   * Native WS-API order client (`factory.ts` `wsApiPrivate`, credentialed). Present with
   * {@link restOrders} + {@link bus} → the WS-first order path is wired; absent any of the
   * three, `placeOrder`/`cancelOrder` fail loud (offline unit tests unaffected).
   */
  readonly wsApiPrivate?: BybitWsOrderClient
  /** Native REST order client (`factory.ts` `native`) — the WS-timeout REST fallback (`11` §5). */
  readonly restOrders?: BybitRestOrderClient
  /** Per-venue submission stagger, ms (`00_globals` §6; Bybit 150). Threaded from the venue profile. */
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

/** Parse a Bybit numeric string field (the transaction log is all strings). */
function num(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** Placeholder public stream when `ws`/`bus` are not injected — every method fails loud. */
function unwiredPublicStream(): PublicStream {
  const fail = (): never => {
    throw new Error('BybitAdapter: public stream requires ws+bus deps')
  }
  return { subscribe: fail, subscribeTicks: fail, unsubscribeTicks: fail, close: fail }
}

/** Placeholder private stream when `wsPrivate`/`bus` are not injected — every method fails loud. */
function unwiredPrivateStream(): PrivateStream {
  const fail = (): never => {
    throw new Error('BybitAdapter: private stream requires wsPrivate+bus deps')
  }
  return { subscribe: fail, close: fail }
}

export function createBybitAdapter(deps: BybitAdapterDeps): ExchangeAdapter {
  const { client, clock, limiter, ws, wsPrivate, bus, wsApiPrivate, restOrders } = deps
  const deny = deps.deny ?? []
  const failures = deps.failures ?? createConsecutiveFailureCounter()
  const log = deps.log ?? (() => {})

  // `clientOrderId → venueSymbol`, populated authoritatively by the transport at submit time
  // and kept warm by the private stream's `order` frames, so `getOrder`/`cancel` can supply
  // the symbol Bybit requires.
  const clientOrderIdToVenue = new Map<string, string>()

  /**
   * Run a general-lane REST read under the limiter, mapping any throw to a typed
   * {@link mapBybitError} error. No limiter → passthrough (raw call, raw throw).
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
  function mapErr(err: unknown): ReturnType<typeof mapBybitError> {
    return mapBybitError(err, { onUnknown: (rawCode) => log('bybit: unmapped venue error code', { rawCode }) })
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
  let reloadHandle: TimerHandle | undefined

  /** Load + validate markets into a fresh registry, then swap the reference in. */
  async function reloadRegistry(): Promise<void> {
    const markets = await callGeneral(WEIGHT_REQUEST, () => client.loadMarkets())
    const next = buildInstrumentRegistry(Object.values(markets), deny, log)
    const reverse = new Map<string, string>()
    for (const inst of next.values()) reverse.set(inst.venueSymbol, inst.normalized)
    instruments = next
    venueToNormalized = reverse
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
    if (!instrument) throw new Error(`BybitAdapter: unknown symbol '${symbol}'`)
    return instrument
  }

  /** Resolve a normalized symbol to its exact venue string for a REST call. */
  function venueSymbol(symbol: string): string {
    return normalize(symbol).venueSymbol
  }

  /**
   * Cached native account setup (`11` §1) backing the three port methods below. General-lane +
   * error-mapped like the other REST calls; the applied-state cache makes a repeat call a
   * no-op. Fails loud when the native client is not injected.
   */
  const accountSetup: BybitAccountSetup | undefined = deps.accountSetup
    ? createBybitAccountSetup({
        client: deps.accountSetup,
        resolveVenue: venueSymbol,
        call: (fn) => callGeneral(WEIGHT_REQUEST, fn),
      })
    : undefined

  function requireAccountSetup(): BybitAccountSetup {
    if (!accountSetup) throw new Error('BybitAdapter: account setup requires the accountSetup dep')
    return accountSetup
  }

  /** Predicted-funding REST read — the `predictedFunding` method and the stream fallback share it. */
  async function readPredictedFunding(symbol: string): Promise<Rate> {
    const fr = await callGeneral(WEIGHT_REQUEST, () => client.fetchFundingRate(venueSymbol(symbol)))
    return { symbol, rate: toSignedPercent(fr.fundingRate), ts: fr.timestamp ?? clock.now() }
  }

  /**
   * Bulk predicted-funding REST read (all-symbol `/v5/market/tickers` behind ccxt) — collapses
   * the public stream's fallback poll/reprime from N per-symbol calls into one. Keyed by venue
   * symbol (raw); the stream resolves + gates each key to its subscribed universe.
   */
  async function readAllPredictedFunding(): Promise<Map<string, Rate>> {
    const rates = await callGeneral(WEIGHT_REQUEST, () => client.fetchFundingRates())
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
    const ticker = await callGeneral(WEIGHT_REQUEST, () => client.fetchTicker(venueSymbol(symbol)))
    const price = ticker.last ?? ticker.close
    if (price === undefined) throw new Error(`BybitAdapter: ticker for '${symbol}' carries no last/close price`)
    return { price, ts: ticker.timestamp ?? clock.now() }
  }

  /**
   * Resolve a ccxt payload's canonical name from its raw venue id (`info.symbol`, e.g.
   * `BTCUSDT`) via the reverse registry — ccxt's unified `symbol` (`BTC/USDT:USDT`) is not a
   * registry key. Returns `undefined` for an unknown symbol (dropped, never guessed).
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
    // Bybit reports `reduceOnly` as a real boolean on the raw row; ccxt surfaces it unified too.
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
    const raw = await callGeneral(WEIGHT_REQUEST, () => client.fetchPositions())
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
    const raw = await callGeneral(WEIGHT_REQUEST, () => client.fetchOpenOrders())
    return raw.map((o) => toOrder(o))
  }

  /**
   * Fill-poll one order by client id. Symbol comes from the submit-time map (`11` §6). ccxt's
   * `fetchOrder` hard-binds the venue `orderId`, so the client-id read goes through
   * `fetchOpenOrders` + `orderLinkId`, which ccxt passes straight to `/v5/order/realtime` —
   * that endpoint returns open **and** recently-closed orders, i.e. the fill-poll window.
   */
  async function readOrder(clientOrderId: string): Promise<Order> {
    const venue = clientOrderIdToVenue.get(clientOrderId)
    if (venue === undefined) {
      throw new NotFoundError(`BybitAdapter.getOrder: no known symbol for clientOrderId '${clientOrderId}'`)
    }
    const rows = await callGeneral(WEIGHT_REQUEST, () =>
      client.fetchOpenOrders(venue, undefined, undefined, { orderLinkId: clientOrderId }),
    )
    const row = rows.find((o) => o.clientOrderId === clientOrderId) ?? rows[0]
    if (row === undefined) {
      throw new NotFoundError(`BybitAdapter.getOrder: order '${clientOrderId}' not found on '${venue}'`)
    }
    return toOrder(row)
  }

  /**
   * The public stream, wired only when both `ws` + `bus` are injected. Absent either, every
   * method throws a clear fail-loud error (offline tests never touch streams, so their
   * construction is unaffected).
   */
  const publicStream: PublicStream =
    ws && bus
      ? createBybitPublicStream({
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
      ? createBybitPrivateStream({
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
      throw new NotFoundError(`BybitAdapter: no known symbol for clientOrderId '${clientOrderId}'`)
    }
    return venue
  }

  /**
   * The WS-first order manager, wired only when the WS-API order client, REST order client and
   * bus are all injected. Absent any, `placeOrder`/`cancelOrder` fail loud. The transport
   * records `clientOrderId → venueSymbol` authoritatively at submit time — unblocking
   * `getOrder`/`cancel`.
   */
  const orderManager: OrderManager | undefined =
    wsApiPrivate && restOrders && bus
      ? createOrderManager({
          transport: createBybitOrderTransport({
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
      throw new Error('BybitAdapter: order path requires wsApiPrivate + restOrders + bus deps')
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
     * Account funding-income credits (`00_globals.md` §6 REST safety net) off the transaction
     * log: `type=SETTLEMENT` rows carry `funding` in the settle coin, **positive = received**
     * (the opposite sign to `execFee`). Filtered to this symbol and the range, since Bybit
     * pages the log account-wide.
     */
    async fundingIncome(symbol: string, range: TimeRange): Promise<FundingIncome[]> {
      const venue = venueSymbol(symbol)
      const rows = await callGeneral(WEIGHT_REQUEST, () =>
        client.fetchLedger(QUOTE_ASSET, range.fromTs, undefined, {
          category: 'linear',
          type: SETTLEMENT_TYPE,
          symbol: venue,
          endTime: range.toTs,
        }),
      )
      const out: FundingIncome[] = []
      for (const row of rows) {
        const info = (typeof row.info === 'object' && row.info !== null ? row.info : {}) as Record<string, unknown>
        if (typeof info.type === 'string' && info.type !== SETTLEMENT_TYPE) continue
        if (typeof info.symbol === 'string' && info.symbol !== venue) continue
        const amount = num(info.funding)
        if (amount === undefined || amount === 0) continue
        const fundingTime = row.timestamp ?? num(info.transactionTime)
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
