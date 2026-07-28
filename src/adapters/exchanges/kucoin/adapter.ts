/**
 * KuCoin {@link ExchangeAdapter} (task 0460) — venue five behind the one port, and the fourth
 * repeat of spec `10`'s central claim: adding a venue is one adapter and **zero** core changes.
 * Structurally a mirror of `../bitget/adapter.ts`: `init()` loads markets via ccxt, filters to
 * active linear USDT-settled swaps, builds a validated `Instrument` registry (fail-loud on any
 * anomaly), reloads it hourly, serves the synchronous `markets()`/`normalize()` reads, the
 * lane-wrapped REST reads, the WS-first order path and the two native streams.
 *
 * KuCoin divergences from the Bitget sibling, all data or adapter-local mapping:
 *
 *  - **real per-endpoint weights.** Bybit, OKX and Bitget publish request *counts*, so every call
 *    there costs `WEIGHT_REQUEST = 1`. KuCoin publishes a genuine weight model over a per-UID
 *    resource pool with a rolling 30 s window, so the reads below draw the venue's own published
 *    weights ({@link WEIGHTS}) — six entries, not a full table (YAGNI), sized in the
 *    `rate_limit_weight_per_minute` derivation comment in `config/exchanges.yaml`.
 *  - **no bulk funding read.** `kucoinfutures.has.fetchFundingRates === false`, so there is no
 *    `readAllPredictedFunding` here and the public stream's fallback fans out per symbol.
 *  - **`getOrder` needs no symbol.** ccxt's `fetchOrder('', undefined, { clientOid })` maps to
 *    `GET /api/v1/orders/byClientOid`, which takes the client id alone — unlike OKX and Bitget,
 *    which both demand the instrument. The `clientOrderId → venue symbol` map is still kept,
 *    because **cancel** needs it (`./ws-orders.ts`).
 *  - **isolated leverage rides the order.** KuCoin has no isolated-leverage endpoint, so
 *    `setLeverage` records the value and the transport reads it back per submit
 *    (`./account-setup.ts` explains why).
 *  - **`fundingIncome` is implemented for real** off ccxt's `fetchFundingHistory`
 *    (`GET /api/v1/funding-history`), which is already scoped to funding settlements — no
 *    ledger/bill-type filtering (Bybit, OKX) and no stub (Binance).
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
import { sumTradeFees } from '../../shared/order-fee.js'
import type { RateLimiter } from '../../shared/rate-limiter.js'
import { createKucoinAccountSetup, type KucoinAccountSetup, type KucoinAccountSetupClient } from './account-setup.js'
import { toVenueClientOid } from './client-order-id.js'
import { mapKucoinError } from './error-map.js'
import type { KucoinMarketClient } from './factory.js'
import { buildInstrumentRegistry, SETTLE_ASSET } from './instrument.js'
import { createKucoinPrivateStream, type KucoinPrivateWsClient } from './private-stream.js'
import { createKucoinPublicStream, type KucoinWsClient, type TickerReading } from './public-stream.js'
import { createKucoinOrderTransport, type KucoinRestOrderClient, type KucoinWsOrderClient } from './ws-orders.js'

const HOUR_MS = 3_600_000

/**
 * General-lane weights (`10` §6) — the venue's own published request weights, which is what makes
 * KuCoin different from its three siblings (see the file header). Six entries cover every REST
 * read this adapter makes; there is deliberately no attempt at a full endpoint table.
 */
const WEIGHTS = {
  /** `GET /api/v1/contracts/active` — the whole listing, the heaviest read here. */
  loadMarkets: 3,
  /** `GET /api/v1/funding-rate/{symbol}/current` and the funding-rate history read. */
  funding: 2,
  /** `GET /api/v1/ticker` — one symbol. */
  ticker: 2,
  /** `GET /api/v1/positions` — account-wide. */
  positions: 2,
  /** `GET /api/v1/account-overview` — the balance read. */
  balance: 5,
  /** `GET /api/v1/orders` and `GET /api/v1/orders/byClientOid`. */
  orders: 2,
  /** `GET /api/v1/fills` — the realized-commission read for a filled order (0470 §6). */
  fills: 5,
} as const

/** Everything the adapter needs, all injectable so unit tests run offline (`10` §2). */
export interface KucoinAdapterDeps {
  /** ccxt-backed market/funding/account client (`./factory.ts`); a fake in tests. */
  readonly client: KucoinMarketClient
  /** Time + timers — the only clock the reload loop reads (`08` §5). */
  readonly clock: Clock
  /** Canonical names to exclude from the universe (`config.symbols.deny`, `10` §3). */
  readonly deny?: readonly string[]
  /**
   * Weighted rate limiter (`10` §6). When present, the REST reads draw the **general** lane and
   * their throws map through {@link mapKucoinError}; when absent the reads pass through raw
   * (keeps the offline unit tests simple). The order lane is drawn by the transport.
   */
  readonly limiter?: RateLimiter
  /** Native account-setup client (`factory.ts` `native`, `FuturesClient`). Absent → setup fails loud. */
  readonly accountSetup?: KucoinAccountSetupClient
  /**
   * Native public market-data WS client (`factory.ts` `wsPublic`). When present with {@link bus}
   * and {@link wsPublicKey}, the public stream is fully wired; when absent, `streams.public.*`
   * throws a clear "requires ws+bus" error so offline tests construct unaffected.
   */
  readonly ws?: KucoinWsClient
  /** The lib's connection key for the public futures socket (`WS_KEY_MAP.futuresPublicV1`). */
  readonly wsPublicKey?: string
  /**
   * Native private account WS client (`factory.ts` `wsPrivate`, credentialed). When present with
   * {@link bus}, the private stream is fully wired; when absent, `streams.private.*` fails loud.
   */
  readonly wsPrivate?: KucoinPrivateWsClient
  /** The lib's connection key for the private futures socket (`WS_KEY_MAP.futuresPrivateV1`). */
  readonly wsPrivateKey?: string
  /** Core event bus the public/private streams publish onto (`08` §4). Paired with {@link ws}/{@link wsPrivate}. */
  readonly bus?: EventBus
  /**
   * Native WS-API order client (`factory.ts` `wsApiPrivate`, credentialed). Present with
   * {@link restOrders} + {@link bus} → the WS-first order path is wired; absent any of the three,
   * `placeOrder`/`cancelOrder` fail loud (offline unit tests unaffected).
   */
  readonly wsApiPrivate?: KucoinWsOrderClient
  /** Native REST order client (`factory.ts` `native`) — the WS-timeout REST fallback (`11` §5). */
  readonly restOrders?: KucoinRestOrderClient
  /** Per-venue submission stagger, ms (`00_globals` §6; KuCoin 100). Threaded from the venue profile. */
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

/** The raw venue symbol a ccxt payload was built from — KuCoin's venue id field. */
function rawVenueSymbol(info: unknown): string | undefined {
  if (typeof info !== 'object' || info === null) return undefined
  const symbol = (info as { symbol?: unknown }).symbol
  return typeof symbol === 'string' ? symbol : undefined
}

/** Placeholder public stream when `ws`/`bus` are not injected — every method fails loud. */
function unwiredPublicStream(): PublicStream {
  const fail = (): never => {
    throw new Error('KucoinAdapter: public stream requires ws+bus deps')
  }
  return { subscribe: fail, subscribeTicks: fail, unsubscribeTicks: fail, close: fail }
}

/** Placeholder private stream when `wsPrivate`/`bus` are not injected — every method fails loud. */
function unwiredPrivateStream(): PrivateStream {
  const fail = (): never => {
    throw new Error('KucoinAdapter: private stream requires wsPrivate+bus deps')
  }
  return { subscribe: fail, close: fail }
}

export function createKucoinAdapter(deps: KucoinAdapterDeps): ExchangeAdapter {
  const { client, clock, limiter, ws, wsPrivate, bus, wsApiPrivate, restOrders } = deps
  const deny = deps.deny ?? []
  const failures = deps.failures ?? createConsecutiveFailureCounter()
  const log = deps.log ?? (() => {})

  // `clientOrderId → venue symbol`, populated authoritatively by the transport at submit time and
  // kept warm by the private stream's order frames. Unlike OKX/Bitget it is **not** needed by
  // `getOrder` (KuCoin reads by client id alone) — it is the **cancel** path that needs it.
  const clientOrderIdToVenue = new Map<string, string>()

  /**
   * Run a general-lane REST read under the limiter, mapping any throw to a typed
   * {@link mapKucoinError} error. No limiter → passthrough (raw call, raw throw).
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
  function mapErr(err: unknown): ReturnType<typeof mapKucoinError> {
    return mapKucoinError(err, { onUnknown: (rawCode) => log('kucoin: unmapped venue error code', { rawCode }) })
  }

  /**
   * Run an order-lane venue call: draw the reserved order lane (never starved by the general
   * poll, `10` §6) and map any throw. Unlike {@link callGeneral} it **always** maps (no limiter →
   * still map), since the order manager relies on seeing only {@link AdapterError}s.
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
  // Reverse index (venue symbol → canonical) for the streams' per-message resolve — O(1) instead
  // of scanning `instruments` on every frame.
  let venueToNormalized = new Map<string, string>()
  let reloadHandle: TimerHandle | undefined

  /** Load + validate markets into a fresh registry, then swap the reference in. */
  async function reloadRegistry(): Promise<void> {
    const markets = await callGeneral(WEIGHTS.loadMarkets, () => client.loadMarkets())
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
    if (!instrument) throw new Error(`KucoinAdapter: unknown symbol '${symbol}'`)
    return instrument
  }

  /** Resolve a normalized symbol to its exact venue symbol for a REST call. */
  function venueSymbol(symbol: string): string {
    return normalize(symbol).venueSymbol
  }

  /**
   * Cached native account setup (`11` §1) backing the three port methods below. General-lane +
   * error-mapped like the other REST calls; the applied-state cache makes a repeat call a no-op.
   * Fails loud when the native client is not injected.
   */
  const accountSetup: KucoinAccountSetup | undefined = deps.accountSetup
    ? createKucoinAccountSetup({
        client: deps.accountSetup,
        resolveVenue: venueSymbol,
        call: (fn) => callGeneral(WEIGHTS.positions, fn),
        log,
      })
    : undefined

  function requireAccountSetup(): KucoinAccountSetup {
    if (!accountSetup) throw new Error('KucoinAdapter: account setup requires the accountSetup dep')
    return accountSetup
  }

  /** Predicted-funding REST read — the `predictedFunding` method and the stream fallback share it. */
  async function readPredictedFunding(symbol: string): Promise<Rate> {
    const fr = await callGeneral(WEIGHTS.funding, () => client.fetchFundingRate(venueSymbol(symbol)))
    return { symbol, rate: toSignedPercent(fr.fundingRate), ts: fr.timestamp ?? clock.now() }
  }

  /** Last-price REST read for the public stream's tick fallback/reprime. */
  async function readTicker(symbol: string): Promise<TickerReading> {
    const ticker = await callGeneral(WEIGHTS.ticker, () => client.fetchTicker(venueSymbol(symbol)))
    const price = ticker.last ?? ticker.close
    if (price === undefined) throw new Error(`KucoinAdapter: ticker for '${symbol}' carries no last/close price`)
    return { price, ts: ticker.timestamp ?? clock.now() }
  }

  /**
   * Resolve a ccxt payload's canonical name from its raw venue symbol (`info.symbol`, e.g.
   * `XBTUSDTM`) via the reverse registry — ccxt's unified `symbol` (`BTC/USDT:USDT`) is not a
   * registry key. Returns `undefined` for an unknown symbol (dropped, never guessed).
   */
  function canonicalOfCcxt(info: unknown): string | undefined {
    const venue = rawVenueSymbol(info)
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
      ...(o.reduceOnly === true ? { reduceOnly: true } : {}),
    }
  }

  /** Account-wide open positions (private-stream reprime + degraded poll, `11` §7). */
  async function readPositions(): Promise<Position[]> {
    const raw = await callGeneral(WEIGHTS.positions, () => client.fetchPositions())
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
    const balances = await callGeneral(WEIGHTS.balance, () => client.fetchBalance())
    const quote = balances[SETTLE_ASSET]
    return { asset: SETTLE_ASSET, free: quote?.free ?? 0, used: quote?.used ?? 0 }
  }

  /** Account-wide open orders (private-stream reprime + the stale reduce-only sweep, `11` §7). */
  async function readOpenOrders(): Promise<Order[]> {
    const raw = await callGeneral(WEIGHTS.orders, () => client.fetchOpenOrders())
    return raw.map((o) => toOrder(o))
  }

  /**
   * Fill-poll one order by client id (`11` §6). KuCoin is the **only** venue of the five where
   * this needs nothing else: ccxt maps `{ clientOid }` to `GET /api/v1/orders/byClientOid`, which
   * is keyed by the client id alone — no instrument (OKX, Bitget) and no open-orders scan
   * (Bybit). So an id this process never submitted still reaches the venue and comes back as its
   * own `NotFound`, rather than short-circuiting on a local map miss.
   */
  async function readOrder(clientOrderId: string): Promise<Order> {
    const row = await callGeneral(WEIGHTS.orders, () =>
      client.fetchOrder('', undefined, { clientOid: toVenueClientOid(clientOrderId) }),
    )
    if (row === undefined || row === null) {
      throw new NotFoundError(`KucoinAdapter.getOrder: order '${clientOrderId}' not found`)
    }
    const order = { ...toOrder(row), clientOrderId }
    if (order.fee !== undefined || order.venueOrderId === undefined) return order
    if (order.status !== 'FILLED' && order.status !== 'PARTIAL') return order
    const fee = await readOrderFee(order.venueOrderId, order.symbol)
    return fee === undefined ? order : { ...order, fee }
  }

  /**
   * Realized commission for a filled order, summed over its executions (`GET /api/v1/fills`).
   *
   * KuCoin's order row carries **no fee field at all** — the fill is real, the cost is invisible
   * (observed live, 0470 §6; Binance behaves the same way). Bounded to a (partly) filled order
   * whose fee is missing, and best-effort: a failed fills read leaves the order fee-less rather
   * than failing the fill-poll it rode in on.
   */
  async function readOrderFee(venueOrderId: string, symbol: string): Promise<number | undefined> {
    try {
      const trades = await callGeneral(WEIGHTS.fills, () =>
        client.fetchMyTrades(venueSymbol(symbol), undefined, undefined, { orderId: venueOrderId }),
      )
      return sumTradeFees(trades, venueOrderId)
    } catch (err) {
      log?.('kucoin: could not read the realized fee for a filled order', { venueOrderId, symbol, err })
      return undefined
    }
  }

  /**
   * The public stream, wired only when `ws` + `bus` + the connection key are all injected. Absent
   * any, every method throws a clear fail-loud error (offline tests never touch streams, so their
   * construction is unaffected).
   */
  const publicStream: PublicStream =
    ws && bus && deps.wsPublicKey !== undefined
      ? createKucoinPublicStream({
          ws,
          bus,
          clock,
          wsKey: deps.wsPublicKey,
          resolveCanonical: (venue) => venueToNormalized.get(venue),
          resolveVenue: venueSymbol,
          restFunding: readPredictedFunding,
          restTicker: readTicker,
        })
      : unwiredPublicStream()

  /**
   * The private account stream, wired only when `wsPrivate` + `bus` + the connection key are all
   * injected. It publishes onto the bus and re-primes via the shared reconnect FSM using the
   * adapter's own REST account reads.
   */
  const privateStream: PrivateStream =
    wsPrivate && bus && deps.wsPrivateKey !== undefined
      ? createKucoinPrivateStream({
          ws: wsPrivate,
          bus,
          clock,
          wsKey: deps.wsPrivateKey,
          resolveCanonical: (venue) => venueToNormalized.get(venue),
          restPositions: readPositions,
          restBalance: readBalance,
          restOpenOrders: readOpenOrders,
          recordOrderSymbol: (clientOrderId, venue) => clientOrderIdToVenue.set(clientOrderId, venue),
        })
      : unwiredPrivateStream()

  /**
   * The WS-first order manager, wired only when the WS-API order client, REST order client and
   * bus are all injected. Absent any, `placeOrder`/`cancelOrder` fail loud. The transport records
   * `clientOrderId → venue symbol` authoritatively at submit time — which is what unblocks
   * `cancelOrder` on this venue.
   */
  const orderManager: OrderManager | undefined =
    wsApiPrivate && restOrders && bus
      ? createOrderManager({
          transport: createKucoinOrderTransport({
            wsApi: wsApiPrivate,
            rest: restOrders,
            clock,
            resolveVenue: venueSymbol,
            recordVenue: (clientOrderId, venue) => clientOrderIdToVenue.set(clientOrderId, venue),
            lookupVenue: (clientOrderId) => clientOrderIdToVenue.get(clientOrderId),
            resolveLeverage: (symbol) => accountSetup?.leverageFor(symbol),
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
      throw new Error('KucoinAdapter: order path requires wsApiPrivate + restOrders + bus deps')
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
      if (ws && bus && deps.wsPublicKey !== undefined) await publicStream.close() // wired only
      if (wsPrivate && bus && deps.wsPrivateKey !== undefined) await privateStream.close()
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
      const rows = await callGeneral(WEIGHTS.funding, () =>
        client.fetchFundingRateHistory(venueSymbol(symbol), range.fromTs),
      )
      return rows
        .filter((r) => r.timestamp !== undefined && r.timestamp >= range.fromTs && r.timestamp <= range.toTs)
        .map((r) => ({ symbol, rate: toSignedPercent(r.fundingRate), settleTs: r.timestamp as number }))
    },
    /**
     * Account funding-income credits (`00_globals.md` §6 REST safety net). ccxt's KuCoin
     * `fetchFundingHistory` reads `GET /api/v1/funding-history`, whose rows are already funding
     * settlements — no bill-type filter (Bybit `SETTLEMENT`, OKX type `8`) and no stub (Binance).
     * `amount` is signed, **positive = received**, matching the port.
     *
     * The range is still re-checked client-side: `since` only bounds the first page, so a row
     * outside the window can come back.
     */
    async fundingIncome(symbol: string, range: TimeRange): Promise<FundingIncome[]> {
      const venue = venueSymbol(symbol)
      const rows = await callGeneral(WEIGHTS.funding, () =>
        client.fetchFundingHistory(venue, range.fromTs, undefined, { endAt: range.toTs }),
      )
      const out: FundingIncome[] = []
      for (const row of rows) {
        const rowVenue = rawVenueSymbol(row.info)
        if (rowVenue !== undefined && rowVenue !== venue) continue
        const amount = row.amount
        if (amount === undefined || amount === null || amount === 0) continue
        const fundingTime = row.timestamp
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
