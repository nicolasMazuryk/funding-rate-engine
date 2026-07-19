/**
 * Minimal in-memory `ExchangeAdapter` — the zero-credential venue the walking
 * skeleton (task 0090) trades against (`0000_agentic-development-environment.md`
 * §5, §8; `10_exchange_adapters_and_market_data.md` §2 interface, §4 Instrument).
 *
 * Happy path only: a few hardcoded instruments, market orders that fill instantly
 * at a scripted mark price, and funding events driven by a small scripting surface.
 * Determinism comes from the `Clock` port (default event timestamps) and the same
 * `EventBus` real adapters publish onto — so the core cannot tell it apart from a
 * live venue. **Fault injection** (partial fills, disconnects, dup events, 429s,
 * latency) and resting limit/stop logic are deliberately out of scope here; task
 * 0160 extends this class with scriptable misbehaviour. Limit orders placed now are
 * rejected, not queued (`placeOrder` below).
 */

import type { EventBus } from '../../core/ports/bus.js'
import type { Clock } from '../../core/ports/clock.js'
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
} from '../../core/ports/exchange-adapter.js'

/** One recorded account-setup call — lets 0090/tests assert setup ran before trading (`11` §1). */
export type SetupCall =
  | { readonly kind: 'setLeverage'; readonly symbol: string; readonly leverage: number }
  | { readonly kind: 'setMarginMode'; readonly symbol: string; readonly mode: MarginMode }
  | { readonly kind: 'setPositionMode'; readonly mode: PositionMode }

/**
 * The sim venue: the full {@link ExchangeAdapter} contract plus a scripting surface
 * (not part of the port) for driving prices and funding in tests. The extra members
 * keep `satisfies ExchangeAdapter` a no-cast proof — an adapter with *more* than the
 * interface is still assignable to it.
 */
export interface SimExchange extends ExchangeAdapter {
  /** Set the mark price used for instant fills and funding notional (normalized symbol). */
  setPrice(symbol: string, px: number): void
  /** Script the predicted rate and publish `FundingPredicted` (`10` §7). Defaults `ts` to `clock.now()`. */
  setPredictedFunding(symbol: string, rate: number, ts?: number): void
  /**
   * Settle funding at `tSettle` (defaults to `clock.now()`): publish `FundingSettled`,
   * append to history, and — for an open position — publish the signed `FundingFeeAccrued`
   * plus the resulting `BalanceUpdate` (`00_globals.md` §3.1 accrual rule).
   */
  settleFunding(symbol: string, rate: number, tSettle?: number): void
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

export function createSimExchange(clock: Clock, bus: EventBus): SimExchange {
  const instruments = seedInstruments()
  const prices = new Map<string, number>()
  const positions = new Map<string, Position>()
  const orders = new Map<string, Order>()
  const predicted = new Map<string, Rate>()
  const history = new Map<string, FundingEvent[]>()
  const setupCalls: SetupCall[] = []
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

  return {
    // ── lifecycle ─────────────────────────────────────────────────────────────
    // Markets are hardcoded, not loaded; streams emit via the scripting methods
    // below, not a subscribe-triggered feed (0160-deferred sharpening).
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
      normalize(req.symbol) // fail-loud on unknown symbol before any state change
      // Limit/stop resting logic is out of scope until 0160: reject, don't queue.
      if (req.type !== 'market') {
        recordOrder(req, 'REJECTED')
        bus.publish({ type: 'OrderUpdate', clientOrderId: req.clientOrderId, status: 'REJECTED' })
        return Promise.resolve({ clientOrderId: req.clientOrderId, accepted: false })
      }

      const price = markPrice(req.symbol)
      let fillQty = req.qty
      if (req.reduceOnly) {
        // Reduce-only caps at the open opposite-side qty — never opens or flips (`10` §2).
        const pos = positions.get(req.symbol)
        const reducible = pos && pos.side !== req.side ? pos.qty : 0
        fillQty = Math.min(req.qty, reducible)
      }

      const result = applyFill(req.symbol, req.side, fillQty, price)
      recordOrder(req, 'FILLED', price, fillQty)
      bus.publish({
        type: 'OrderUpdate',
        clientOrderId: req.clientOrderId,
        status: 'FILLED',
        fillPx: price,
        qty: fillQty,
      })
      bus.publish({
        type: 'PositionUpdate',
        symbol: req.symbol,
        qty: result?.qty ?? 0,
        side: result?.side ?? req.side,
      })
      return Promise.resolve({
        clientOrderId: req.clientOrderId,
        accepted: true,
        venueOrderId: req.clientOrderId,
      })
    },
    cancelOrder(clientOrderId: string): Promise<void> {
      // No resting orders in the happy path — the order is already terminal. Still
      // validate the id exists (fail-loud); the cancel itself is a no-op.
      if (!orders.has(clientOrderId)) {
        throw new Error(`SimExchange: unknown order '${clientOrderId}'`)
      }
      return Promise.resolve()
    },
    getOrder(clientOrderId: string): Promise<Order> {
      const order = orders.get(clientOrderId)
      if (!order) throw new Error(`SimExchange: unknown order '${clientOrderId}'`)
      return Promise.resolve(order)
    },
    getPositions(): Promise<Position[]> {
      return Promise.resolve([...positions.values()])
    },
    getBalance(): Promise<Balance> {
      return Promise.resolve(balance)
    },

    // ── funding ───────────────────────────────────────────────────────────────
    predictedFunding(symbol: string): Promise<Rate> {
      const rate = predicted.get(symbol)
      if (!rate) throw new Error(`SimExchange: no predicted funding scripted for '${symbol}'`)
      return Promise.resolve(rate)
    },
    fundingHistory(symbol: string, range: TimeRange): Promise<FundingEvent[]> {
      const all = history.get(symbol) ?? []
      return Promise.resolve(all.filter((e) => e.settleTs >= range.fromTs && e.settleTs <= range.toTs))
    },

    // ── streams (no-op; emission is via the scripting surface — 0160 sharpens) ─
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
      // Publish a MarketTick so the engine's preflight has a known price (fail-closed
      // on unknown price would otherwise skip the symbol — `12` §3).
      bus.publish({ type: 'MarketTick', symbol, price: px, ts: clock.now() })
    },
    setPredictedFunding(symbol: string, rate: number, ts: number = clock.now()): void {
      const reading: Rate = { symbol, rate, ts }
      predicted.set(symbol, reading)
      bus.publish({ type: 'FundingPredicted', symbol, rate, ts })
    },
    settleFunding(symbol: string, rate: number, tSettle: number = clock.now()): void {
      bus.publish({ type: 'FundingSettled', symbol, rate, settleTs: tSettle })
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
      bus.publish({ type: 'FundingFeeAccrued', symbol, amount, fundingTime: tSettle })

      balance = { ...balance, free: balance.free + amount }
      bus.publish({ type: 'BalanceUpdate', asset: balance.asset, free: balance.free, used: balance.used })
    },
    get setupCalls(): readonly SetupCall[] {
      return setupCalls
    },
  }
}
