/**
 * In-memory `ExchangeAdapter` — the zero-credential venue the pure core trades
 * against (`0000_agentic-development-environment.md` §5, §8; `10` §2 interface,
 * §4 Instrument). Task 0060 gave the happy path; task 0160 turns the `13` §6
 * failure catalog into scriptable, deterministic misbehaviour.
 *
 * The happy path is unchanged and faults are opt-in per scenario: market orders
 * still fill instantly at the scripted mark price. On top of that, this class can be
 * told to rest limit/stop orders against a scripted price path, fill them partially,
 * expire them, reject them (precision / min-notional / reduce-only / margin), drop /
 * duplicate / delay / reorder stream events (via {@link ./fault-emitter.js}), and
 * throw typed venue errors per call class (via {@link ./sim-venue-error.js}).
 * Determinism comes from the {@link Clock} port and event ordinals — never wall clock
 * or randomness. The full mapped error taxonomy + token-bucket rate limiter are 0200.
 */

import type { EventBus } from '../../core/ports/bus.js'
import type { Clock, TimerHandle } from '../../core/ports/clock.js'
import type {
  Balance,
  ExchangeAdapter,
  FundingEvent,
  Instrument,
  MarginMode,
  Market,
  Order,
  OrderAck,
  OrderRequest,
  Position,
  PositionMode,
  Rate,
  Side,
  TimeRange,
  VenueErrorKind,
} from '../../core/ports/exchange-adapter.js'
import { capReduceOnlyQty } from '../../core/sizing/sizing.js'
import { createFaultEmitter, type FaultRule } from './fault-emitter.js'
import { type FailSpec, type SimCallClass, SimVenueError } from './sim-venue-error.js'

/** One recorded account-setup call — lets 0090/tests assert setup ran before trading (`11` §1). */
export type SetupCall =
  | { readonly kind: 'setLeverage'; readonly symbol: string; readonly leverage: number }
  | { readonly kind: 'setMarginMode'; readonly symbol: string; readonly mode: MarginMode }
  | { readonly kind: 'setPositionMode'; readonly mode: PositionMode }

/** A limit/stop order living on the sim book until its price crosses or it expires. */
interface RestingOrder {
  readonly req: OrderRequest
  status: 'OPEN' | 'PARTIAL'
  /** Base units still to fill. */
  remaining: number
  /** Cumulative filled base units. */
  filledQty: number
  expireHandle?: TimerHandle
}

/** A reject verdict from {@link validateOrder} — surfaced onto `OrderUpdate.reason`/`errorKind`. */
interface RejectVerdict {
  readonly reason: string
  readonly errorKind: VenueErrorKind
}

/**
 * The sim venue: the full {@link ExchangeAdapter} contract plus a scripting surface
 * (not part of the port) for driving prices, funding, and faults in tests. The extra
 * members keep `satisfies ExchangeAdapter` a no-cast proof — an adapter with *more*
 * than the interface is still assignable to it.
 */
export interface SimExchange extends ExchangeAdapter {
  /** Set the mark price used for instant fills, funding notional, and resting-order crossing (normalized symbol). */
  setPrice(symbol: string, px: number): void
  /** Script the predicted rate and publish `FundingPredicted` (`10` §7). Defaults `ts` to `clock.now()`. */
  setPredictedFunding(symbol: string, rate: number, ts?: number): void
  /**
   * Settle funding at `tSettle` (defaults to `clock.now()`): publish `FundingSettled`,
   * append to history, and — for an open position — publish the signed `FundingFeeAccrued`
   * plus the resulting `BalanceUpdate` (`00_globals.md` §3.1 accrual rule).
   */
  settleFunding(symbol: string, rate: number, tSettle?: number): void

  // ── fault scripting (task 0160; all keyed on clock/ordinals, never randomness) ──
  /** Fill a resting order across several price crossings by this queue of qtys (default: full fill on first crossing). */
  scriptPartialFills(clientOrderId: string, qtys: readonly number[]): void
  /** Add an arbitrary stream-fault rule (escape hatch under the named sugar below). */
  scriptFault(rule: FaultRule): void
  /** Publish the next `OrderUpdate` twice (generic duplicate-event injection). */
  duplicateNextOrderUpdate(): void
  /** Hold the next `OrderUpdate` until `n` later emits pass — genuine out-of-order arrival. */
  reorderNextOrderUpdate(n: number): void
  /** Deliver the next `FundingFeeAccrued` late, by `ms` on the virtual clock. */
  delayFundingFee(ms: number): void
  /** Swallow the next `FundingFeeAccrued` entirely (absent funding fee). */
  dropFundingFee(): void
  /** Drop every private-lane event emitted while `clock.now()` is within `[fromTs, toTs]`. */
  disconnectPrivate(fromTs: number, toTs: number): void
  /** Drop every public-lane event emitted while `clock.now()` is within `[fromTs, toTs]`. */
  disconnectPublic(fromTs: number, toTs: number): void
  /** Throw a typed {@link SimVenueError} on the given 1-based call ordinals of `callClass`. */
  scriptRateLimit(callClass: SimCallClass, kind: VenueErrorKind, failOnCallNumbers: readonly number[]): void

  /** Account-setup calls recorded in order (`setLeverage`/`setMarginMode`/`setPositionMode`). */
  readonly setupCalls: readonly SetupCall[]
}

/** 3 hardcoded instruments; `PEPE` carries `contractSize 1000` to cover the `10` §4 denomination case. */
function seedInstruments(): Map<string, Instrument> {
  const list: readonly Instrument[] = [
    {
      normalized: 'BTC',
      venueSymbol: 'BTCUSDT',
      contractSize: 1,
      pricePrecision: 0.1,
      amountPrecision: 0.001,
      minNotional: 5,
      minQty: 0.001,
      fundingIntervalHours: 8,
    },
    {
      normalized: 'ETH',
      venueSymbol: 'ETHUSDT',
      contractSize: 1,
      pricePrecision: 0.01,
      amountPrecision: 0.01,
      minNotional: 5,
      minQty: 0.01,
      fundingIntervalHours: 8,
    },
    {
      normalized: 'PEPE',
      venueSymbol: '1000PEPEUSDT',
      contractSize: 1000,
      pricePrecision: 0.0000001,
      amountPrecision: 1,
      minNotional: 5,
      minQty: 1,
      fundingIntervalHours: 8,
    },
  ]
  return new Map(list.map((i) => [i.normalized, i]))
}

/** True when `value` is not an integer multiple of `step` (tolerant of float error). */
function offGrid(value: number, step: number): boolean {
  const q = value / step
  return Math.abs(q - Math.round(q)) > 1e-9
}

export function createSimExchange(clock: Clock, bus: EventBus): SimExchange {
  const instruments = seedInstruments()
  const prices = new Map<string, number>()
  const positions = new Map<string, Position>()
  const orders = new Map<string, Order>()
  const restingOrders = new Map<string, RestingOrder>()
  const partialScripts = new Map<string, number[]>()
  const predicted = new Map<string, Rate>()
  const history = new Map<string, FundingEvent[]>()
  const setupCalls: SetupCall[] = []
  const callCounts = new Map<SimCallClass, number>()
  const failSpecs = new Map<SimCallClass, FailSpec>()
  const emitter = createFaultEmitter(bus, clock)
  let balance: Balance = { asset: 'USDT', free: 10_000, used: 0 }

  /** Look up an instrument; fail loud on an unknown symbol — mirrors real-adapter startup validation (`10` §4). */
  function normalize(symbol: string): Instrument {
    const instrument = instruments.get(symbol)
    if (!instrument) throw new Error(`SimExchange: unknown symbol '${symbol}'`)
    return instrument
  }

  /** Mark price for `symbol`; fail loud rather than silently zero-filling (`10` §4). */
  function markPrice(symbol: string): number {
    const px = prices.get(symbol)
    if (px === undefined) throw new Error(`SimExchange: no price scripted for '${symbol}'`)
    return px
  }

  /**
   * Count this call and throw a scripted {@link SimVenueError} on matching ordinals,
   * else invoke `fn`. Wraps every REST-shaped method so a scenario can inject a 429
   * burst / venue-unavailable streak without a token bucket (that is 0200).
   */
  function guardCall<T>(callClass: SimCallClass, fn: () => T): T {
    const n = (callCounts.get(callClass) ?? 0) + 1
    callCounts.set(callClass, n)
    const spec = failSpecs.get(callClass)
    if (spec?.failOnCallNumbers.has(n)) throw new SimVenueError(spec.kind, callClass)
    return fn()
  }

  /**
   * Apply a fill to the single one-way position for `symbol` and return the
   * resulting position (`undefined` when flat). Same side increases (weighted-avg
   * entry); opposite side decreases/flattens; a flip only happens for a non-reduce
   * order whose qty exceeds the open position (reduce-only is pre-capped so it never
   * flips — `10` §2 reduce-only semantics).
   */
  function applyFill(symbol: string, side: Side, qty: number, price: number): Position | undefined {
    const existing = positions.get(symbol)
    if (!existing || existing.qty === 0) {
      if (qty === 0) return undefined
      const opened: Position = { symbol, side, qty, entryPrice: price }
      positions.set(symbol, opened)
      return opened
    }
    if (existing.side === side) {
      const newQty = existing.qty + qty
      const entryPrice = (existing.qty * (existing.entryPrice ?? price) + qty * price) / newQty
      const increased: Position = { symbol, side, qty: newQty, entryPrice }
      positions.set(symbol, increased)
      return increased
    }
    // Opposite side: reduce, flatten, or flip.
    if (qty < existing.qty) {
      const reduced: Position = { ...existing, qty: existing.qty - qty }
      positions.set(symbol, reduced)
      return reduced
    }
    if (qty === existing.qty) {
      positions.delete(symbol)
      return undefined
    }
    const flipped: Position = { symbol, side, qty: qty - existing.qty, entryPrice: price }
    positions.set(symbol, flipped)
    return flipped
  }

  /** Reduce-only caps at the open opposite-side qty — never opens or flips (`10` §2). */
  function cappedFillQty(req: OrderRequest, requestedQty: number): number {
    if (!req.reduceOnly) return requestedQty
    const pos = positions.get(req.symbol)
    const reducible = pos && pos.side !== req.side ? pos.qty : 0
    return capReduceOnlyQty(requestedQty, reducible)
  }

  function recordOrder(req: OrderRequest, status: Order['status'], fillPx?: number, qty?: number): void {
    orders.set(req.clientOrderId, {
      clientOrderId: req.clientOrderId,
      venueOrderId: req.clientOrderId,
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      status,
      fillPx,
      qty,
    })
  }

  /**
   * Validate a resting (limit/stop) order before it joins the book. Checks in `13`/`11`
   * order: precision, min-notional, reduce-only violation, margin. Market orders keep
   * 0060's untouched fill path (they skip validation, including the reduce-only cap that
   * flattens rather than violates) so happy-path tests do not regress.
   */
  function validateOrder(
    req: OrderRequest,
    instrument: Instrument,
    position: Position | undefined,
  ): RejectVerdict | undefined {
    if (req.price === undefined)
      throw new Error(`SimExchange: ${req.type} order '${req.clientOrderId}' requires a price`)
    if (offGrid(req.qty, instrument.amountPrecision) || offGrid(req.price, instrument.pricePrecision)) {
      return { reason: 'precision', errorKind: 'OrderRejected' }
    }
    const notional = req.qty * req.price * instrument.contractSize
    if (notional < instrument.minNotional) return { reason: 'min_notional', errorKind: 'OrderRejected' }
    if (req.reduceOnly) {
      const opposite = position !== undefined && position.side !== req.side && position.qty > 0
      if (!opposite) return { reason: 'reduce_only_violation', errorKind: 'OrderRejected' }
      return undefined // reduce-only closes need no free margin
    }
    if (notional > balance.free) return { reason: 'margin', errorKind: 'InsufficientBalance' }
    return undefined
  }

  /** Fill a market order instantly at the mark price — 0060's happy path, now via the fault emitter. */
  function placeMarket(req: OrderRequest): Promise<OrderAck> {
    const price = markPrice(req.symbol)
    const fillQty = cappedFillQty(req, req.qty)
    const result = applyFill(req.symbol, req.side, fillQty, price)
    recordOrder(req, 'FILLED', price, fillQty)
    emitter.emit({
      type: 'OrderUpdate',
      clientOrderId: req.clientOrderId,
      status: 'FILLED',
      fillPx: price,
      qty: fillQty,
    })
    emitter.emit({ type: 'PositionUpdate', symbol: req.symbol, qty: result?.qty ?? 0, side: result?.side ?? req.side })
    return Promise.resolve({ clientOrderId: req.clientOrderId, accepted: true, venueOrderId: req.clientOrderId })
  }

  /** Validate then rest a limit/stop order: reject, or record `OPEN` and await a price crossing. */
  function placeResting(req: OrderRequest): Promise<OrderAck> {
    const instrument = normalize(req.symbol)
    const reject = validateOrder(req, instrument, positions.get(req.symbol))
    if (reject) {
      recordOrder(req, 'REJECTED')
      emitter.emit({
        type: 'OrderUpdate',
        clientOrderId: req.clientOrderId,
        status: 'REJECTED',
        reason: reject.reason,
        errorKind: reject.errorKind,
      })
      return Promise.resolve({ clientOrderId: req.clientOrderId, accepted: false })
    }
    const order: RestingOrder = { req, status: 'OPEN', remaining: req.qty, filledQty: 0 }
    if (req.expireAt !== undefined) {
      order.expireHandle = clock.scheduleTimer(req.expireAt, () => expireOrder(req.clientOrderId))
    }
    restingOrders.set(req.clientOrderId, order)
    recordOrder(req, 'OPEN', undefined, 0)
    emitter.emit({ type: 'OrderUpdate', clientOrderId: req.clientOrderId, status: 'OPEN' })
    return Promise.resolve({ clientOrderId: req.clientOrderId, accepted: true, venueOrderId: req.clientOrderId })
  }

  /** Does the mark `px` cross this resting order favourably (limit) or trigger it (stop)? */
  function crosses(order: RestingOrder, px: number): boolean {
    const limit = order.req.price as number
    const long = order.req.side === 'long'
    if (order.req.type === 'limit') return long ? px <= limit : px >= limit
    // stop: buy-stop triggers as price rises to it, sell-stop as it falls to it.
    return long ? px >= limit : px <= limit
  }

  /**
   * Fill (part of) a resting order at a crossing. Consumes one entry from its partial
   * script if scripted, else fills the remainder; emits `PARTIAL` until done, then
   * `FILLED`, plus the resulting `PositionUpdate`. Limits fill at the limit price;
   * stops fill at the current mark (`px`), mirroring the sim's mark-fill convention.
   */
  function fillResting(order: RestingOrder, px: number): void {
    const fillPrice = order.req.type === 'limit' ? (order.req.price as number) : px
    const script = partialScripts.get(order.req.clientOrderId)
    const nextQty = script && script.length > 0 ? Math.min(script.shift() as number, order.remaining) : order.remaining
    const fillQty = cappedFillQty(order.req, nextQty)
    order.remaining -= fillQty
    order.filledQty += fillQty
    const result = applyFill(order.req.symbol, order.req.side, fillQty, fillPrice)
    const done = order.remaining <= 0
    if (!done) order.status = 'PARTIAL'
    recordOrder(order.req, done ? 'FILLED' : 'PARTIAL', fillPrice, order.filledQty)
    emitter.emit({
      type: 'OrderUpdate',
      clientOrderId: order.req.clientOrderId,
      status: done ? 'FILLED' : 'PARTIAL',
      fillPx: fillPrice,
      qty: order.filledQty,
    })
    emitter.emit({
      type: 'PositionUpdate',
      symbol: order.req.symbol,
      qty: result?.qty ?? 0,
      side: result?.side ?? order.req.side,
    })
    if (done) {
      order.expireHandle?.cancel()
      restingOrders.delete(order.req.clientOrderId)
    }
  }

  /** Walk resting orders for `symbol`; fill each whose price now crosses. */
  function crossRestingOrders(symbol: string, px: number): void {
    for (const order of [...restingOrders.values()]) {
      if (order.req.symbol === symbol && crosses(order, px)) fillResting(order, px)
    }
  }

  /** Expiry timer fired: if still (partially) open, mark `EXPIRED` — the `limit-never-fills` catalog row. */
  function expireOrder(clientOrderId: string): void {
    const order = restingOrders.get(clientOrderId)
    if (!order) return // already filled or cancelled
    restingOrders.delete(clientOrderId)
    recordOrder(order.req, 'EXPIRED', undefined, order.filledQty)
    emitter.emit({ type: 'OrderUpdate', clientOrderId, status: 'EXPIRED', qty: order.filledQty })
  }

  return {
    // ── lifecycle ─────────────────────────────────────────────────────────────
    init(): Promise<void> {
      return Promise.resolve()
    },
    close(): Promise<void> {
      return Promise.resolve()
    },

    // ── account setup (no-op recorders — `11` §1) ─────────────────────────────
    setLeverage(symbol: string, leverage: number): Promise<void> {
      setupCalls.push({ kind: 'setLeverage', symbol, leverage })
      return Promise.resolve()
    },
    setMarginMode(symbol: string, mode: MarginMode): Promise<void> {
      setupCalls.push({ kind: 'setMarginMode', symbol, mode })
      return Promise.resolve()
    },
    setPositionMode(mode: PositionMode): Promise<void> {
      setupCalls.push({ kind: 'setPositionMode', mode })
      return Promise.resolve()
    },

    // ── market metadata ───────────────────────────────────────────────────────
    markets(): Market[] {
      return [...instruments.values()].map((i) => ({
        normalized: i.normalized,
        venueSymbol: i.venueSymbol,
        status: 'trading',
      }))
    },
    normalize,

    // ── orders ────────────────────────────────────────────────────────────────
    placeOrder(req: OrderRequest): Promise<OrderAck> {
      return guardCall('placeOrder', () => {
        normalize(req.symbol) // fail-loud on unknown symbol before any state change
        return req.type === 'market' ? placeMarket(req) : placeResting(req)
      })
    },
    cancelOrder(clientOrderId: string): Promise<void> {
      return guardCall('cancelOrder', () => {
        const resting = restingOrders.get(clientOrderId)
        if (resting) {
          resting.expireHandle?.cancel()
          restingOrders.delete(clientOrderId)
          recordOrder(resting.req, 'CANCELLED', undefined, resting.filledQty)
          emitter.emit({ type: 'OrderUpdate', clientOrderId, status: 'CANCELLED', qty: resting.filledQty })
          return Promise.resolve()
        }
        // Terminal (market) orders have no resting state — validate the id, no-op the cancel.
        if (!orders.has(clientOrderId)) throw new Error(`SimExchange: unknown order '${clientOrderId}'`)
        return Promise.resolve()
      })
    },
    getOrder(clientOrderId: string): Promise<Order> {
      return guardCall('getOrder', () => {
        const order = orders.get(clientOrderId)
        if (!order) throw new Error(`SimExchange: unknown order '${clientOrderId}'`)
        return Promise.resolve(order)
      })
    },
    getPositions(): Promise<Position[]> {
      return guardCall('getPositions', () => Promise.resolve([...positions.values()]))
    },
    getBalance(): Promise<Balance> {
      return guardCall('getBalance', () => Promise.resolve(balance))
    },

    // ── funding ───────────────────────────────────────────────────────────────
    predictedFunding(symbol: string): Promise<Rate> {
      return guardCall('predictedFunding', () => {
        const rate = predicted.get(symbol)
        if (!rate) throw new Error(`SimExchange: no predicted funding scripted for '${symbol}'`)
        return Promise.resolve(rate)
      })
    },
    fundingHistory(symbol: string, range: TimeRange): Promise<FundingEvent[]> {
      return guardCall('fundingHistory', () => {
        const all = history.get(symbol) ?? []
        return Promise.resolve(all.filter((e) => e.settleTs >= range.fromTs && e.settleTs <= range.toTs))
      })
    },

    // ── streams (no-op; emission is via the scripting surface below) ──────────
    streams: {
      public: {
        subscribe(): Promise<void> {
          return Promise.resolve()
        },
        close(): Promise<void> {
          return Promise.resolve()
        },
      },
      private: {
        subscribe(): Promise<void> {
          return Promise.resolve()
        },
        close(): Promise<void> {
          return Promise.resolve()
        },
      },
    },

    // ── scripting surface (not part of ExchangeAdapter) ───────────────────────
    setPrice(symbol: string, px: number): void {
      normalize(symbol) // reject prices for unknown symbols, fail-loud
      prices.set(symbol, px)
      // Publish a MarketTick so the engine's preflight has a known price (`12` §3), then
      // advance the book — resting orders whose price now crosses fill (venue-internal,
      // so it happens even when a public disconnect drops the tick from the client).
      emitter.emit({ type: 'MarketTick', symbol, price: px, ts: clock.now() })
      crossRestingOrders(symbol, px)
    },
    setPredictedFunding(symbol: string, rate: number, ts: number = clock.now()): void {
      const reading: Rate = { symbol, rate, ts }
      predicted.set(symbol, reading)
      emitter.emit({ type: 'FundingPredicted', symbol, rate, ts })
    },
    settleFunding(symbol: string, rate: number, tSettle: number = clock.now()): void {
      emitter.emit({ type: 'FundingSettled', symbol, rate, settleTs: tSettle })
      const events = history.get(symbol) ?? []
      events.push({ symbol, rate, settleTs: tSettle })
      history.set(symbol, events)

      const pos = positions.get(symbol)
      if (!pos) return // no open position ⇒ no accrual (task verification step 2)

      // Accrual convention (`00_globals.md` §1.1/§3.1): with negative `rate`, longs
      // receive +|F|, shorts pay −|F| — so the signed pct is `-rate` for longs, `+rate`
      // for shorts. Amount is that pct of notional, in quote currency (USDT).
      const notional = pos.qty * markPrice(symbol) * normalize(symbol).contractSize
      const signedFundingPct = pos.side === 'long' ? -rate : rate
      const amount = (notional * signedFundingPct) / 100
      emitter.emit({ type: 'FundingFeeAccrued', symbol, amount, fundingTime: tSettle })

      balance = { ...balance, free: balance.free + amount }
      emitter.emit({ type: 'BalanceUpdate', asset: balance.asset, free: balance.free, used: balance.used })
    },

    scriptPartialFills(clientOrderId: string, qtys: readonly number[]): void {
      partialScripts.set(clientOrderId, [...qtys])
    },
    scriptFault(rule: FaultRule): void {
      emitter.addRule(rule)
    },
    duplicateNextOrderUpdate(): void {
      emitter.addRule({ matches: (e) => e.type === 'OrderUpdate', action: 'duplicate', count: 1 })
    },
    reorderNextOrderUpdate(n: number): void {
      emitter.addRule({ matches: (e) => e.type === 'OrderUpdate', action: { holdForEmits: n }, count: 1 })
    },
    delayFundingFee(ms: number): void {
      emitter.addRule({ matches: (e) => e.type === 'FundingFeeAccrued', action: { delayMs: ms }, count: 1 })
    },
    dropFundingFee(): void {
      emitter.addRule({ matches: (e) => e.type === 'FundingFeeAccrued', action: 'drop', count: 1 })
    },
    disconnectPrivate(fromTs: number, toTs: number): void {
      emitter.addRule({
        matches: (_e, channel) => channel === 'private' && clock.now() >= fromTs && clock.now() <= toTs,
        action: 'drop',
        count: Number.POSITIVE_INFINITY,
      })
    },
    disconnectPublic(fromTs: number, toTs: number): void {
      emitter.addRule({
        matches: (_e, channel) => channel === 'public' && clock.now() >= fromTs && clock.now() <= toTs,
        action: 'drop',
        count: Number.POSITIVE_INFINITY,
      })
    },
    scriptRateLimit(callClass: SimCallClass, kind: VenueErrorKind, failOnCallNumbers: readonly number[]): void {
      failSpecs.set(callClass, { kind, failOnCallNumbers: new Set(failOnCallNumbers) })
    },
    get setupCalls(): readonly SetupCall[] {
      return setupCalls
    },
  }
}
