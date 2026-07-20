/**
 * Binance private (authenticated) user-data WS stream
 * (`11_execution_and_account_state.md` §7). The write-side counterpart to the 0210
 * public market-data stream — same pipeline, same shared reconnect FSM.
 *
 * Three account signals, normalized onto the core event bus:
 *  - **Orders** — `ORDER_TRADE_UPDATE` → `OrderUpdate`, drives the order FSM (0230).
 *  - **Positions / balances** — `ACCOUNT_UPDATE` → `PositionUpdate` / `BalanceUpdate`,
 *    feed the position tracker + preflight + risk (0240 / `12` / `13`).
 *  - **Funding fee** — `ACCOUNT_UPDATE` with `updateEventType === 'FUNDING_FEE'` →
 *    `FundingFeeAccrued`, the live signal that funding actually credited (`11` §9). Under
 *    the `11` §1 isolated-margin mandate the event carries the affected position (`P[].s`),
 *    so we shape `{ symbol, amount, fundingTime }` from the WS alone; REST income
 *    (`fapi/v1/income`) stays the funding gate's (0290) ground-truth safety net.
 *
 * Listen-key lifecycle (create / keepalive / refresh / reconnect / resubscribe) is owned
 * by the native lib's `subscribeUsdFuturesUserDataStream()` — we do not hand-roll it
 * (KISS). Our shared {@link ReconnectController} sits on top: while the socket is down a
 * REST poll keeps positions/balances fresh, and on reconnect we re-prime a full snapshot
 * (positions → balances → open orders) before trusting the WS again.
 *
 * Pipeline per message: lib formatted event → lib type-guard → pure map → `bus.publish`.
 * Handlers never throw into the socket lib (0210 rule).
 */

import {
  isWsFormattedFuturesUserDataAccountUpdate,
  isWsFormattedFuturesUserDataTradeUpdateEvent,
  type WsMessageFuturesUserDataAccountUpdateFormatted,
  type WsMessageFuturesUserDataTradeUpdateEventFormatted,
  type WsUserDataEvents,
} from 'binance'
import type {
  BalanceUpdate,
  EngineEvent,
  FundingFeeAccrued,
  OrderUpdate,
  PositionUpdate,
} from '../../../core/events/types.js'
import type { EventBus } from '../../../core/ports/bus.js'
import type { Clock } from '../../../core/ports/clock.js'
import type {
  Balance,
  Order,
  OrderStatus,
  Position,
  PrivateStream,
  Side,
} from '../../../core/ports/exchange-adapter.js'
import type { ReconnectController } from '../../shared/reconnect.js'
import { createReconnectController } from '../../shared/reconnect.js'

/** REST poll cadence while degraded — well inside the 60 s freshness gate (`00_globals.md` §7). */
const FALLBACK_POLL_MS = 15_000

/**
 * Binance `orderStatus` → engine {@link OrderStatus} (`11` §6). `SUBMITTING`/`FAILED` are
 * producer-side (0230 `placeOrder`), never from the stream; `PENDING_CANCEL` has no engine
 * analogue → dropped. An unknown status also maps to `undefined` and is dropped (logged
 * once a logger exists), so a lib change never publishes a bogus terminal state.
 */
const BINANCE_ORDER_STATUS: Partial<Record<string, OrderStatus>> = {
  NEW: 'OPEN',
  PARTIALLY_FILLED: 'PARTIAL',
  FILLED: 'FILLED',
  CANCELED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
  REJECTED: 'REJECTED',
}

/**
 * Map an `ORDER_TRADE_UPDATE` to an {@link OrderUpdate}, or `null` when the venue status
 * has no engine analogue (dropped, never a bogus state). `fillPx`/`qty` are carried only
 * once there is a fill (average price / cumulative filled qty > 0), so a bare `NEW`/reject
 * publishes neither. A `REJECTED` carries `errorKind: 'OrderRejected'` plus any venue
 * `orderExpireReason` as `reason`.
 */
export function orderTradeUpdateToOrderUpdate(
  msg: WsMessageFuturesUserDataTradeUpdateEventFormatted,
): OrderUpdate | null {
  const order = msg.order
  const status = BINANCE_ORDER_STATUS[order.orderStatus]
  if (status === undefined) return null

  const filled = order.orderFilledAccumulatedQuantity
  const avg = order.averagePrice
  const update: OrderUpdate = { type: 'OrderUpdate', clientOrderId: order.clientOrderId, status }
  return {
    ...update,
    ...(avg > 0 ? { fillPx: avg } : {}),
    ...(filled > 0 ? { qty: filled } : {}),
    ...(status === 'REJECTED'
      ? { errorKind: 'OrderRejected', ...(order.orderExpireReason ? { reason: order.orderExpireReason } : {}) }
      : {}),
  }
}

/** Absolute-position quantity → engine side; a flat/zero position defaults to `long` (qty 0). */
function sideOfAmount(positionAmount: number): Side {
  return positionAmount < 0 ? 'short' : 'long'
}

/**
 * Map an `ACCOUNT_UPDATE` to its fan-out of engine events (`11` §7). Emits, in order: one
 * {@link PositionUpdate} per updated position that resolves, one {@link BalanceUpdate} per
 * updated balance, and — only when `updateEventType === 'FUNDING_FEE'` — one
 * {@link FundingFeeAccrued} per resolved position (amount from the matching quote-asset
 * balance change, `fundingTime` from `transactionTime`). Total and never throws; an
 * unresolved venue symbol is skipped.
 *
 * `BalanceUpdate` free/used is **approximate from the WS** (ACCOUNT_UPDATE carries wallet
 * balances, not a clean split): `free = crossWalletBalance`,
 * `used = max(0, walletBalance − crossWalletBalance)`. REST `getBalance` (ccxt) is the
 * authoritative split, pulled on reprime + by preflight.
 */
export function accountUpdateToEvents(
  msg: WsMessageFuturesUserDataAccountUpdateFormatted,
  resolveCanonical: (venueSymbol: string) => string | undefined,
): EngineEvent[] {
  const { updateEventType, updatedPositions, updatedBalances } = msg.updateData
  const events: EngineEvent[] = []

  for (const p of updatedPositions) {
    const symbol = resolveCanonical(p.symbol)
    if (symbol === undefined) continue
    const position: PositionUpdate = {
      type: 'PositionUpdate',
      symbol,
      qty: Math.abs(p.positionAmount),
      side: sideOfAmount(p.positionAmount),
    }
    events.push(position)
  }

  for (const b of updatedBalances) {
    const balance: BalanceUpdate = {
      type: 'BalanceUpdate',
      asset: b.asset,
      free: b.crossWalletBalance,
      used: Math.max(0, b.walletBalance - b.crossWalletBalance),
    }
    events.push(balance)
  }

  // ±30 s `11` §7 vs the normative ±5 s: the tolerance is the funding gate's (0290, ROADMAP
  // A1); this adapter only delivers a faithful `fundingTime`.
  if (updateEventType === 'FUNDING_FEE') {
    for (const p of updatedPositions) {
      const symbol = resolveCanonical(p.symbol)
      if (symbol === undefined) continue
      const quote = updatedBalances.find((b) => b.asset === p.marginAsset)
      if (quote === undefined) continue // no matching quote-asset change → cannot attribute an amount
      const fee: FundingFeeAccrued = {
        type: 'FundingFeeAccrued',
        symbol,
        amount: quote.balanceChange,
        fundingTime: msg.transactionTime,
      }
      events.push(fee)
    }
  }

  return events
}

/** The slice of the native credentialed `WebsocketClient` the private stream uses. */
export interface BinancePrivateWsClient {
  subscribeUsdFuturesUserDataStream(...args: unknown[]): Promise<unknown>
  on(event: string, listener: (arg: unknown) => void): unknown
  closeAll(force?: boolean): void
}

export interface BinancePrivateStreamDeps {
  readonly ws: BinancePrivateWsClient
  readonly bus: EventBus
  readonly clock: Clock
  /** Venue id → canonical name off the live registry (`BTCUSDT` → `BTC`), or `undefined` if unknown. */
  resolveCanonical(venueSymbol: string): string | undefined
  /** REST account-wide positions — the reprime + degraded-poll ground truth. */
  restPositions(): Promise<Position[]>
  /** REST balance (authoritative free/used) — reprime + degraded-poll. */
  restBalance(): Promise<Balance>
  /** REST open orders — reprime only (fills can't be polled cheaply). */
  restOpenOrders(): Promise<Order[]>
  /**
   * Record the venue symbol seen on an `ORDER_TRADE_UPDATE` so the adapter's `getOrder`
   * can resolve its required symbol from a `clientOrderId`. 0230 `placeOrder` will populate
   * this authoritatively; the stream keeps it warm from live order events meanwhile.
   */
  recordOrderSymbol(clientOrderId: string, venueSymbol: string): void
}

/** Map an already-normalized REST {@link Order} to an {@link OrderUpdate} for the bus. */
function orderToUpdate(order: Order): OrderUpdate {
  return {
    type: 'OrderUpdate',
    clientOrderId: order.clientOrderId,
    status: order.status,
    ...(order.fillPx !== undefined ? { fillPx: order.fillPx } : {}),
    ...(order.qty !== undefined ? { qty: order.qty } : {}),
  }
}

export function createBinancePrivateStream(deps: BinancePrivateStreamDeps): PrivateStream {
  const { ws, bus, clock, resolveCanonical, restPositions, restBalance, restOpenOrders, recordOrderSymbol } = deps

  /** Dispatch a formatted user-data event → pure map → publish. Never throws into the socket lib. */
  function onFormattedMessage(msg: WsUserDataEvents): void {
    try {
      if (isWsFormattedFuturesUserDataTradeUpdateEvent(msg)) {
        recordOrderSymbol(msg.order.clientOrderId, msg.order.symbol)
        const event = orderTradeUpdateToOrderUpdate(msg)
        if (event !== null) bus.publish(event)
        return
      }
      if (isWsFormattedFuturesUserDataAccountUpdate(msg)) {
        for (const event of accountUpdateToEvents(msg, resolveCanonical)) bus.publish(event)
      }
    } catch {
      // A bad message must never propagate into the socket lib's emit loop.
    }
  }

  /** Positions + balance snapshot — shared by the degraded fallback poll and reprime. */
  async function pollAccount(): Promise<void> {
    for (const p of await restPositions()) {
      bus.publish({ type: 'PositionUpdate', symbol: p.symbol, qty: p.qty, side: p.side })
    }
    const balance = await restBalance()
    bus.publish({ type: 'BalanceUpdate', asset: balance.asset, free: balance.free, used: balance.used })
  }

  /** Full reprime snapshot in order: positions → balance → open orders, before resuming live. */
  async function reprime(): Promise<void> {
    await pollAccount()
    for (const order of await restOpenOrders()) bus.publish(orderToUpdate(order))
  }

  // Fallback poll: self-rescheduling while degraded; `onEnterDegraded` returns its stopper.
  // No order poll — fills can't be polled cheaply; reprime adds open orders on reconnect.
  const reconnect: ReconnectController = createReconnectController({
    clock,
    onEnterDegraded(): () => void {
      let cancelled = false
      const tick = (): void => {
        if (cancelled) return
        void pollAccount().finally(() => {
          if (!cancelled) clock.scheduleTimer(clock.now() + FALLBACK_POLL_MS, tick)
        })
      }
      tick()
      return () => {
        cancelled = true
      }
    },
    onReprime: reprime,
  })

  ws.on('formattedUserDataMessage', (arg) => onFormattedMessage(arg as WsUserDataEvents))
  ws.on('reconnecting', () => reconnect.markDisconnected())
  ws.on('reconnected', () => reconnect.markReconnected())

  return {
    async subscribe(): Promise<void> {
      await ws.subscribeUsdFuturesUserDataStream()
    },
    close(): Promise<void> {
      ws.closeAll()
      return Promise.resolve()
    },
  }
}
