/**
 * Bitget {@link ExchangeAdapter} (task 0440) — venue four behind the one port, and the third
 * repeat of spec `10`'s central claim: adding a venue is one adapter and **zero** core changes.
 * Structurally a mirror of `../okx/adapter.ts`: `init()` loads markets via ccxt, filters to
 * active linear USDT-settled swaps, builds a validated `Instrument` registry (fail-loud on any
 * anomaly), reloads it hourly, serves the synchronous `markets()`/`normalize()` reads, the
 * lane-wrapped REST reads, the WS-first order path and the two native streams.
 *
 * Bitget divergences from the OKX sibling, all data or adapter-local mapping:
 *  - **one registry call.** The funding interval is a market-metadata field
 *    (`info.fundInterval`, in hours), so `reloadRegistry` is a bare `loadMarkets()` — no
 *    companion funding-rate read (OKX) and no second endpoint (Binance).
 *  - **`contractSize` is 1 everywhere.** Bitget sizes in base units, so `computeQty`'s division
 *    is a no-op and the only face value in play is the symbol multiplier (`1000BONK` → 1000),
 *    folded at registry build. `./instrument.ts` makes the `=== 1` invariant fatal rather than
 *    assumed.
 *  - **the venue id is `info.symbol`**, matching Bybit and unlike OKX's `info.instId`.
 *  - **`fundingIncome` is implemented for real** and is the simplest of the four: ccxt's
 *    `fetchFundingHistory` has a genuine UTA branch, so the rows arrive already scoped to
 *    funding settlements — no bill-type filtering out of a generic ledger (Bybit, OKX) and no
 *    stub (Binance). It matters here: the WS funding signal is an inferred `totalFundingFee`
 *    delta (`./private-stream.ts`), so this read is the money truth.
 *  - **UTA everywhere.** ccxt is pinned to `uta: true` in the factory, which is what makes the
 *    reads below hit `/api/v3/...` rather than silently falling back to the v2 mix endpoints.
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
import { type BitgetAccountSetup, type BitgetAccountSetupClient, createBitgetAccountSetup } from './account-setup.js'
import { toVenueClientOid } from './client-order-id.js'
import { mapBitgetError } from './error-map.js'
import type { BitgetMarketClient } from './factory.js'
import { buildInstrumentRegistry, SETTLE_ASSET } from './instrument.js'
import { type BitgetPrivateWsClient, createBitgetPrivateStream } from './private-stream.js'
import { type BitgetWsClient, createBitgetPublicStream, type TickerReading } from './public-stream.js'
import { type BitgetRestOrderClient, type BitgetWsOrderClient, createBitgetOrderTransport } from './ws-orders.js'

const HOUR_MS = 3_600_000

/**
 * General-lane weight (`10` §6). Bitget has **no** request-weight model — the published UTA
 * caps are per-request-count per UID (10 place-order/s, 20 order-info/s, ~20/s on the public
 * reads) — so one call costs one token on every lane and there is no per-endpoint table to
 * mirror. The single constant keeps the accounting explicit rather than sprinkling literal `1`s
 * through the reads.
 */
const WEIGHT_REQUEST = 1

/** Everything the adapter needs, all injectable so unit tests run offline (`10` §2). */
export interface BitgetAdapterDeps {
  /** ccxt-backed market/funding/account client (`./factory.ts`); a fake in tests. */
  readonly client: BitgetMarketClient
  /** Time + timers — the only clock the reload loop reads (`08` §5). */
  readonly clock: Clock
  /** Canonical names to exclude from the universe (`config.symbols.deny`, `10` §3). */
  readonly deny?: readonly string[]
  /**
   * Weighted rate limiter (`10` §6). When present, the REST reads draw the **general** lane and
   * their throws map through {@link mapBitgetError}; when absent the reads pass through raw
   * (keeps the offline unit tests simple). The order lane is drawn by the transport.
   */
  readonly limiter?: RateLimiter
  /** Native account-setup client (`factory.ts` `native`, `RestClientV3`). Absent → setup fails loud. */
  readonly accountSetup?: BitgetAccountSetupClient
  /**
   * Native public market-data WS client (`factory.ts` `wsPublic`). When present with {@link bus}
   * and {@link wsPublicKey}, the public stream is fully wired; when absent, `streams.public.*`
   * throws a clear "requires ws+bus" error so offline tests construct unaffected.
   */
  readonly ws?: BitgetWsClient
  /** The lib's connection key for the public v3 socket (`WS_KEY_MAP.v3Public`). */
  readonly wsPublicKey?: string
  /**
   * Native private account WS client (`factory.ts` `wsPrivate`, credentialed). When present with
   * {@link bus}, the private stream is fully wired; when absent, `streams.private.*` fails loud.
   */
  readonly wsPrivate?: BitgetPrivateWsClient
  /** The lib's connection key for the private v3 socket (`WS_KEY_MAP.v3Private`). */
  readonly wsPrivateKey?: string
  /** Core event bus the public/private streams publish onto (`08` §4). Paired with {@link ws}/{@link wsPrivate}. */
  readonly bus?: EventBus
  /**
   * Native WS-API order client (`factory.ts` `wsApiPrivate`, credentialed). Present with
   * {@link restOrders} + {@link bus} → the WS-first order path is wired; absent any of the
   * three, `placeOrder`/`cancelOrder` fail loud (offline unit tests unaffected).
   */
  readonly wsApiPrivate?: BitgetWsOrderClient
  /** Native REST order client (`factory.ts` `native`) — the WS-timeout REST fallback (`11` §5). */
  readonly restOrders?: BitgetRestOrderClient
  /** Per-venue submission stagger, ms (`00_globals` §6; Bitget 100). Threaded from the venue profile. */
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

/** The raw venue symbol a ccxt payload was built from — Bitget's venue id field. */
function rawVenueSymbol(info: unknown): string | undefined {
  if (typeof info !== 'object' || info === null) return undefined
  const symbol = (info as { symbol?: unknown }).symbol
  return typeof symbol === 'string' ? symbol : undefined
}

/** Settle asset for the linear USDT-perp universe; the `coin` scope of the financial records. */
const QUOTE_ASSET = 'USDT'

/** The v3 product this adapter trades — the `category` scope of the financial records. */
const PRODUCT_TYPE = 'USDT-FUTURES'

/** Page size for the financial-records read. One settlement is one row; this is ample. */
const FINANCIAL_RECORDS_LIMIT = 100

/** One raw `/api/v3/account/financial-records` row, as the venue sends it (numbers as strings). */
interface FinancialRecord {
  readonly type?: unknown
  readonly symbol?: unknown
  readonly amount?: unknown
  /** Where an **isolated** position's settlement lands — `amount` is `"0"` on those rows. */
  readonly positionAmount?: unknown
  readonly ts?: unknown
}

/** A raw Bitget numeric field (they arrive as strings) as a finite number, else `undefined`. */
function num(raw: unknown): number | undefined {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

/** The `data.list` rows of a financial-records reply, defensively — the envelope is untyped. */
function financialRecords(reply: unknown): readonly FinancialRecord[] {
  if (typeof reply !== 'object' || reply === null) return []
  const data = (reply as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return []
  const list = (data as { list?: unknown }).list
  return Array.isArray(list) ? (list as FinancialRecord[]) : []
}

/**
 * The direction of a funding settlement row, or `undefined` when the row is not one.
 *
 * Bitget types the settlement by **margin mode**: `MARGIN_SETTLE_FEE_USER_*` for an isolated
 * position (all of this engine's, `11` §1), `CONTRACT_MAIN_SETTLE_FEE_USER_*` for a cross one.
 * Matching on the shared suffix covers both without pinning either prefix, and the `_IN`/`_OUT`
 * tail is the credit-positive convention the port wants (`_OUT` is unobserved live).
 */
function settlementSign(type: unknown): number | undefined {
  if (typeof type !== 'string' || !type.includes('SETTLE_FEE_USER_')) return undefined
  if (type.endsWith('_USER_IN')) return 1
  if (type.endsWith('_USER_OUT')) return -1
  return undefined
}

/** Placeholder public stream when `ws`/`bus` are not injected — every method fails loud. */
function unwiredPublicStream(): PublicStream {
  const fail = (): never => {
    throw new Error('BitgetAdapter: public stream requires ws+bus deps')
  }
  return { subscribe: fail, subscribeTicks: fail, unsubscribeTicks: fail, close: fail }
}

/** Placeholder private stream when `wsPrivate`/`bus` are not injected — every method fails loud. */
function unwiredPrivateStream(): PrivateStream {
  const fail = (): never => {
    throw new Error('BitgetAdapter: private stream requires wsPrivate+bus deps')
  }
  return { subscribe: fail, close: fail }
}

export function createBitgetAdapter(deps: BitgetAdapterDeps): ExchangeAdapter {
  const { client, clock, limiter, ws, wsPrivate, bus, wsApiPrivate, restOrders } = deps
  const deny = deps.deny ?? []
  const failures = deps.failures ?? createConsecutiveFailureCounter()
  const log = deps.log ?? (() => {})

  // `clientOrderId → venue symbol`, populated authoritatively by the transport at submit time
  // and kept warm by the private stream's `order` frames, so `getOrder` can supply the
  // instrument ccxt's Bitget `fetchOrder` demands.
  const clientOrderIdToVenue = new Map<string, string>()

  /**
   * Run a general-lane REST read under the limiter, mapping any throw to a typed
   * {@link mapBitgetError} error. No limiter → passthrough (raw call, raw throw).
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
  function mapErr(err: unknown): ReturnType<typeof mapBitgetError> {
    return mapBitgetError(err, { onUnknown: (rawCode) => log('bitget: unmapped venue error code', { rawCode }) })
  }

  /**
   * Run an order-lane venue call: draw the reserved order lane (never starved by the general
   * poll, `10` §6) and map any throw. Unlike {@link callGeneral} it **always** maps (no limiter
   * → still map), since the order manager relies on seeing only {@link AdapterError}s.
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
  // Reverse index (venue symbol → canonical) for the streams' per-message resolve — O(1)
  // instead of scanning `instruments` on every frame.
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
    if (!instrument) throw new Error(`BitgetAdapter: unknown symbol '${symbol}'`)
    return instrument
  }

  /** Resolve a normalized symbol to its exact venue symbol for a REST call. */
  function venueSymbol(symbol: string): string {
    return normalize(symbol).venueSymbol
  }

  /**
   * Cached native account setup (`11` §1) backing the three port methods below. General-lane +
   * error-mapped like the other REST calls; the applied-state cache makes a repeat call a
   * no-op. Fails loud when the native client is not injected.
   */
  const accountSetup: BitgetAccountSetup | undefined = deps.accountSetup
    ? createBitgetAccountSetup({
        client: deps.accountSetup,
        resolveVenue: venueSymbol,
        call: (fn) => callGeneral(WEIGHT_REQUEST, fn),
        log,
      })
    : undefined

  function requireAccountSetup(): BitgetAccountSetup {
    if (!accountSetup) throw new Error('BitgetAdapter: account setup requires the accountSetup dep')
    return accountSetup
  }

  /** Predicted-funding REST read — the `predictedFunding` method and the stream fallback share it. */
  async function readPredictedFunding(symbol: string): Promise<Rate> {
    const fr = await callGeneral(WEIGHT_REQUEST, () => client.fetchFundingRate(venueSymbol(symbol)))
    return { symbol, rate: toSignedPercent(fr.fundingRate), ts: fr.timestamp ?? clock.now() }
  }

  /**
   * Bulk predicted-funding REST read — one all-symbol call replaces the per-symbol fan-out in
   * the public stream's fallback poll/reprime. Keyed by venue symbol (raw); the stream resolves
   * + gates each key to its subscribed universe.
   */
  async function readAllPredictedFunding(): Promise<Map<string, Rate>> {
    const rates = await callGeneral(WEIGHT_REQUEST, () => client.fetchFundingRates())
    const out = new Map<string, Rate>()
    for (const fr of Object.values(rates)) {
      const venue = rawVenueSymbol(fr.info)
      if (venue === undefined) continue
      out.set(venue, { symbol: venue, rate: toSignedPercent(fr.fundingRate), ts: fr.timestamp ?? clock.now() })
    }
    return out
  }

  /** Last-price REST read for the public stream's tick fallback/reprime. */
  async function readTicker(symbol: string): Promise<TickerReading> {
    const ticker = await callGeneral(WEIGHT_REQUEST, () => client.fetchTicker(venueSymbol(symbol)))
    const price = ticker.last ?? ticker.close
    if (price === undefined) throw new Error(`BitgetAdapter: ticker for '${symbol}' carries no last/close price`)
    return { price, ts: ticker.timestamp ?? clock.now() }
  }

  /**
   * Resolve a ccxt payload's canonical name from its raw venue symbol (`info.symbol`, e.g.
   * `1000BONKUSDT`) via the reverse registry — ccxt's unified `symbol` (`BONK/USDT:USDT`) is not
   * a registry key. Returns `undefined` for an unknown symbol (dropped, never guessed).
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

  /** A raw Bitget numeric field (they arrive as strings) as a usable number, else `undefined`. */
  function numericOrUndefined(raw: unknown): number | undefined {
    const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN
    return Number.isFinite(n) && n > 0 ? n : undefined
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
    // Bitget reports `reduceOnly` as the string `"YES"`/`"yes"` on the raw row; ccxt surfaces
    // the unified boolean when it can parse it.
    const info =
      typeof o.info === 'object' && o.info !== null
        ? (o.info as { reduceOnly?: unknown; avgPrice?: unknown })
        : undefined
    const rawReduceOnly = typeof info?.reduceOnly === 'string' ? info.reduceOnly.toLowerCase() : undefined
    const reduceOnly = o.reduceOnly === true || rawReduceOnly === 'yes' || rawReduceOnly === 'true'
    // ccxt's v3 order parse leaves `average` unset, so a filled order would carry no fill price
    // at all (observed live, 0470 §6 — the fill was real, the read was blind). The raw row's
    // `avgPrice` is the venue's own fill-weighted average, in quote currency.
    const fillPx = o.average ?? numericOrUndefined(info?.avgPrice)
    // Realized fill fee (quote ccy) for the reconciliation fills-dimension (`15` §2, 0400).
    // Bitget signs a *charge* negative through ccxt while the raw `feeDetail` is positive; the
    // port's `fee` is a positive cost on every venue, so the magnitude is what travels (0470 §6).
    // A maker rebate would be indistinguishable from a charge here — noted in SUGGESTIONS.
    const feeCost = o.fee?.cost
    return {
      clientOrderId: o.clientOrderId ?? '',
      ...(o.id ? { venueOrderId: o.id } : {}),
      symbol: canonicalOfCcxt(o.info) ?? o.symbol ?? '',
      side: o.side === 'sell' ? 'short' : 'long',
      type: o.type === 'limit' ? 'limit' : o.type === 'stop' ? 'stop' : 'market',
      status: ccxtOrderStatus(o.status, filled),
      ...(fillPx !== undefined && fillPx !== null ? { fillPx } : {}),
      ...(filled > 0 ? { qty: filled } : {}),
      ...(feeCost !== undefined && feeCost !== null ? { fee: Math.abs(feeCost) } : {}),
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
    const quote = balances[SETTLE_ASSET]
    return { asset: SETTLE_ASSET, free: quote?.free ?? 0, used: quote?.used ?? 0 }
  }

  /** Account-wide open orders (private-stream reprime + the stale reduce-only sweep, `11` §7). */
  async function readOpenOrders(): Promise<Order[]> {
    const raw = await callGeneral(WEIGHT_REQUEST, () => client.fetchOpenOrders())
    return raw.map((o) => toOrder(o))
  }

  /**
   * Fill-poll one order by client id (`11` §6). ccxt's Bitget `fetchOrder` takes the client id
   * directly (`{ clientOid }` → `GET /api/v3/trade/order-info`) but **demands the instrument**,
   * which comes from the submit-time map — an id this process never submitted is a local typed
   * `NotFound` rather than a venue round-trip.
   */
  async function readOrder(clientOrderId: string): Promise<Order> {
    const venue = clientOrderIdToVenue.get(clientOrderId)
    if (venue === undefined) {
      throw new NotFoundError(`BitgetAdapter.getOrder: no known symbol for clientOrderId '${clientOrderId}'`)
    }
    const row = await callGeneral(WEIGHT_REQUEST, () =>
      client.fetchOrder('', venue, { clientOid: toVenueClientOid(clientOrderId) }),
    )
    if (row === undefined || row === null) {
      throw new NotFoundError(`BitgetAdapter.getOrder: order '${clientOrderId}' not found on '${venue}'`)
    }
    return { ...toOrder(row), clientOrderId }
  }

  /**
   * The public stream, wired only when `ws` + `bus` + the connection key are all injected.
   * Absent any, every method throws a clear fail-loud error (offline tests never touch streams,
   * so their construction is unaffected).
   */
  const publicStream: PublicStream =
    ws && bus && deps.wsPublicKey !== undefined
      ? createBitgetPublicStream({
          ws,
          bus,
          clock,
          wsKey: deps.wsPublicKey,
          resolveCanonical: (venue) => venueToNormalized.get(venue),
          resolveVenue: venueSymbol,
          restFundingAll: readAllPredictedFunding,
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
      ? createBitgetPrivateStream({
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
   * bus are all injected. Absent any, `placeOrder`/`cancelOrder` fail loud. The transport
   * records `clientOrderId → venue symbol` authoritatively at submit time — unblocking
   * `getOrder`.
   */
  const orderManager: OrderManager | undefined =
    wsApiPrivate && restOrders && bus
      ? createOrderManager({
          transport: createBitgetOrderTransport({
            wsApi: wsApiPrivate,
            rest: restOrders,
            clock,
            resolveVenue: venueSymbol,
            recordVenue: (clientOrderId, venue) => clientOrderIdToVenue.set(clientOrderId, venue),
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
      throw new Error('BitgetAdapter: order path requires wsApiPrivate + restOrders + bus deps')
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
      const rows = await callGeneral(WEIGHT_REQUEST, () =>
        client.fetchFundingRateHistory(venueSymbol(symbol), range.fromTs),
      )
      return rows
        .filter((r) => r.timestamp !== undefined && r.timestamp >= range.fromTs && r.timestamp <= range.toTs)
        .map((r) => ({ symbol, rate: toSignedPercent(r.fundingRate), settleTs: r.timestamp as number }))
    },
    /**
     * Account funding-income credits (`00_globals.md` §6 REST safety net), parsed from the raw
     * UTA financial records rather than through ccxt's `fetchFundingHistory`.
     *
     * ccxt hits the same endpoint but cannot see an **isolated** position's settlement (observed
     * live, 0470 §7 — the run held a real position across a real settlement and the read came
     * back empty while the private stream reported the credit): it keeps only rows typed
     * `CONTRACT_MAIN_SETTLE_FEE_USER_*`, whereas an isolated position's funding is typed
     * `MARGIN_SETTLE_FEE_USER_*`, and it reads the `amount` field, which is `"0"` on those rows
     * because the credit lands in the **position's** margin and is carried on `positionAmount`.
     * Every order this engine places is isolated (`11` §1), so ccxt's reader would always return
     * nothing. See {@link BitgetMarketClient.privateUtaGetV3AccountFinancialRecords}.
     *
     * The sign comes from the row **type**, not from the number: `_USER_IN` is received,
     * `_USER_OUT` is paid, matching the port's credit-positive convention. Only `_USER_IN` has
     * been observed live (the harness holds a long into negative funding).
     *
     * The range is re-checked client-side: the venue pages by cursor and `startTime` only bounds
     * the first page, so a row outside the window can come back.
     */
    async fundingIncome(symbol: string, range: TimeRange): Promise<FundingIncome[]> {
      const venue = venueSymbol(symbol)
      const reply = await callGeneral(WEIGHT_REQUEST, () =>
        client.privateUtaGetV3AccountFinancialRecords({
          coin: QUOTE_ASSET,
          category: PRODUCT_TYPE,
          startTime: range.fromTs,
          endTime: range.toTs,
          limit: FINANCIAL_RECORDS_LIMIT,
        }),
      )
      const out: FundingIncome[] = []
      for (const row of financialRecords(reply)) {
        if (rawVenueSymbol(row) !== venue) continue
        const sign = settlementSign(row.type)
        if (sign === undefined) continue
        // `positionAmount` for an isolated settlement, `amount` for a cross one — whichever the
        // venue actually filled in. Both are magnitudes here; the type carries the direction.
        const magnitude = Math.abs(num(row.positionAmount) ?? num(row.amount) ?? 0)
        if (magnitude === 0) continue
        const fundingTime = num(row.ts)
        if (fundingTime === undefined || fundingTime < range.fromTs || fundingTime > range.toTs) continue
        out.push({ symbol, amount: sign * magnitude, fundingTime })
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
