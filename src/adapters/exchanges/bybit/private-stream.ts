/**
 * Bybit private (authenticated) account WS stream (`11_execution_and_account_state.md` §7)
 * — the write-side counterpart of the public market-data stream, mirroring
 * `../binance/private-stream.ts`: same pipeline, same shared reconnect FSM.
 *
 * Four topics, one connection (`subscribeV5(['order','execution','position','wallet'])`),
 * normalized onto the core event bus:
 *  - **`order`** → `OrderUpdate` (drives the order FSM). `orderLinkId` is our
 *    `clientOrderId`, so the transport's id round-trips.
 *  - **`position`** → `PositionUpdate`; **`wallet`** → `BalanceUpdate`. Bybit reports a real
 *    `availableToWithdraw` / `walletBalance` split per coin, so — unlike Binance, which
 *    forces an approximation off `crossWalletBalance` — the WS balance is exact.
 *  - **`execution`** with `execType === 'Funding'` → `FundingFeeAccrued`. `execFee` is the
 *    funding **charge** (positive = paid), the opposite sign convention to the REST
 *    transaction-log's `funding` field, so the amount is negated into the port's
 *    credit-positive convention.
 *
 * Auth, keepalive, reconnect and resubscribe are owned by the native lib (KISS). Our shared
 * {@link ReconnectController} sits on top: while the socket is down a REST poll keeps
 * positions/balances fresh, and on reconnect we re-prime a full snapshot (positions →
 * balances → open orders) before trusting the WS again.
 *
 * Whether UTA actually pushes `execution` frames with `execType: 'Funding'` is **not settled
 * by the Bybit docs** (task 0420 risk note). This mapping is the primary path; the funding
 * gate's REST safety net is `adapter.ts`'s `fundingIncome` (transaction-log `SETTLEMENT`),
 * which is implemented for real on this venue. The testnet tier records which one fires.
 */

import type { CategoryV5, WSAccountOrderV5, WSExecutionV5, WSPositionV5, WSWalletV5 } from 'bybit-api'
import type {
  BalanceUpdate,
  EngineEvent,
  FundingFeeAccrued,
  OrderUpdate,
  PositionUpdate,
} from '../../../core/events/types.js'
import type { EventBus } from '../../../core/ports/bus.js'
import type { Clock } from '../../../core/ports/clock.js'
import type { Balance, Order, OrderStatus, Position, PrivateStream } from '../../../core/ports/exchange-adapter.js'
import type { ReconnectController } from '../../shared/reconnect.js'
import { createReconnectController } from '../../shared/reconnect.js'

/** Linear USDT perpetuals; ignored by the lib for private topics but required by the signature. */
const CATEGORY: CategoryV5 = 'linear'
/** The four private topics the engine needs (`11` §7). */
const TOPICS = ['order', 'execution', 'position', 'wallet'] as const
/** REST poll cadence while degraded — well inside the 60 s freshness gate (`00_globals.md` §7). */
const FALLBACK_POLL_MS = 15_000

/**
 * Bybit `orderStatus` → engine {@link OrderStatus} (`11` §6). `SUBMITTING`/`FAILED` are
 * producer-side (`ws-orders.ts`), never from the stream. The conditional-order lifecycle
 * states (`Untriggered`/`Triggered`/`Active`) have no engine analogue and are **dropped**,
 * as is any unknown status — so a lib or venue change never publishes a bogus terminal state.
 */
const BYBIT_ORDER_STATUS: Partial<Record<string, OrderStatus>> = {
  Created: 'OPEN',
  New: 'OPEN',
  PartiallyFilled: 'PARTIAL',
  // Terminal: partially filled, then cancelled — the engine treats it as a cancel with a fill.
  PartiallyFilledCanceled: 'CANCELLED',
  Filled: 'FILLED',
  Cancelled: 'CANCELLED',
  Deactivated: 'CANCELLED',
  Rejected: 'REJECTED',
}

/** A private-topic frame as it arrives (`{topic, creationTime, data: […]}`). */
export interface BybitPrivateFrame<T> {
  readonly topic: string
  readonly creationTime?: number
  readonly data?: readonly T[]
}

/** Parse a Bybit numeric string field; `undefined` when absent/empty/unparsable. */
function num(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** True when the frame is the named private topic carrying a data array. */
function isFrame<T>(msg: unknown, topic: string): msg is BybitPrivateFrame<T> {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { topic?: unknown }).topic === topic &&
    Array.isArray((msg as { data?: unknown }).data)
  )
}

/**
 * Map one `order` row to an {@link OrderUpdate}, or `null` when the venue status has no
 * engine analogue (dropped, never a bogus state). `fillPx`/`qty` are carried only once there
 * is a fill (`avgPrice`, `cumExecQty` > 0), so a bare `New`/reject publishes neither. A
 * `Rejected` carries `errorKind: 'OrderRejected'` plus any venue `rejectReason` as `reason`.
 */
export function orderRowToOrderUpdate(row: WSAccountOrderV5): OrderUpdate | null {
  const status = BYBIT_ORDER_STATUS[row.orderStatus]
  if (status === undefined) return null

  const filled = num(row.cumExecQty) ?? 0
  const avg = num(row.avgPrice) ?? 0
  const update: OrderUpdate = { type: 'OrderUpdate', clientOrderId: row.orderLinkId, status }
  return {
    ...update,
    ...(avg > 0 ? { fillPx: avg } : {}),
    ...(filled > 0 ? { qty: filled } : {}),
    ...(status === 'REJECTED'
      ? {
          errorKind: 'OrderRejected' as const,
          ...(row.rejectReason ? { reason: row.rejectReason } : {}),
        }
      : {}),
  }
}

/**
 * Map one `position` row to a {@link PositionUpdate}; `null` when the symbol does not
 * resolve. Bybit reports `size` as an absolute string and the direction in `side`
 * (`'Buy'`/`'Sell'`/`''` when flat — a flat position defaults to `long` at qty 0, matching
 * the Binance sibling and the position tracker's expectation).
 */
export function positionRowToPositionUpdate(
  row: WSPositionV5,
  resolveCanonical: (venueSymbol: string) => string | undefined,
): PositionUpdate | null {
  const symbol = resolveCanonical(row.symbol)
  if (symbol === undefined) return null
  return {
    type: 'PositionUpdate',
    symbol,
    qty: Math.abs(num(row.size) ?? 0),
    side: row.side === 'Sell' ? 'short' : 'long',
  }
}

/**
 * Map one `wallet` row to a {@link BalanceUpdate} per coin. Bybit gives an exact split:
 * `free = availableToWithdraw` (falling back to `free` when the account type reports it
 * there), `used = max(0, walletBalance − free)`.
 */
export function walletRowToBalanceUpdates(row: WSWalletV5): BalanceUpdate[] {
  const out: BalanceUpdate[] = []
  for (const coin of row.coin ?? []) {
    const wallet = num(coin.walletBalance) ?? 0
    const free = num(coin.availableToWithdraw) ?? num(coin.free) ?? wallet
    out.push({ type: 'BalanceUpdate', asset: coin.coin, free, used: Math.max(0, wallet - free) })
  }
  return out
}

/**
 * Map one `execution` row to a {@link FundingFeeAccrued}, or `null` when it is not a funding
 * settlement / does not resolve. Sign: `execFee` is the charge (positive = paid), the port
 * wants credit-positive, hence the negation. `execTime` is epoch ms as a string.
 *
 * ±30 s `11` §7 vs the normative ±5 s: the tolerance is the funding gate's (0290); this
 * adapter only delivers a faithful `fundingTime`.
 */
export function executionRowToFundingFee(
  row: WSExecutionV5,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  now: () => number,
): FundingFeeAccrued | null {
  if (row.execType !== 'Funding') return null
  const symbol = resolveCanonical(row.symbol)
  if (symbol === undefined) return null
  const fee = num(row.execFee)
  if (fee === undefined) return null
  return { type: 'FundingFeeAccrued', symbol, amount: -fee, fundingTime: num(row.execTime) ?? now() }
}

/** The slice of the native credentialed `WebsocketClient` the private stream uses. */
export interface BybitPrivateWsClient {
  subscribeV5(topics: string[] | string, category: CategoryV5, isPrivateTopic?: boolean): Promise<unknown>[]
  on(event: string, listener: (arg: unknown) => void): unknown
  closeAll(force?: boolean): void
}

export interface BybitPrivateStreamDeps {
  readonly ws: BybitPrivateWsClient
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
   * Record the venue symbol seen on an `order` frame so the adapter's `getOrder` can resolve
   * the symbol Bybit REST requires from a `clientOrderId`. `ws-orders.ts` populates this
   * authoritatively at submit time; the stream keeps it warm from live order events.
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

export function createBybitPrivateStream(deps: BybitPrivateStreamDeps): PrivateStream {
  const { ws, bus, clock, resolveCanonical, restPositions, restBalance, restOpenOrders, recordOrderSymbol } = deps

  /** Fan one frame out to its engine events (pure), in topic order. */
  function toEvents(msg: unknown): EngineEvent[] {
    if (isFrame<WSAccountOrderV5>(msg, 'order')) {
      const out: EngineEvent[] = []
      for (const row of msg.data ?? []) {
        recordOrderSymbol(row.orderLinkId, row.symbol)
        const event = orderRowToOrderUpdate(row)
        if (event !== null) out.push(event)
      }
      return out
    }
    if (isFrame<WSPositionV5>(msg, 'position')) {
      const out: EngineEvent[] = []
      for (const row of msg.data ?? []) {
        const event = positionRowToPositionUpdate(row, resolveCanonical)
        if (event !== null) out.push(event)
      }
      return out
    }
    if (isFrame<WSWalletV5>(msg, 'wallet')) {
      return (msg.data ?? []).flatMap((row) => walletRowToBalanceUpdates(row))
    }
    if (isFrame<WSExecutionV5>(msg, 'execution')) {
      const out: EngineEvent[] = []
      for (const row of msg.data ?? []) {
        const event = executionRowToFundingFee(row, resolveCanonical, clock.now)
        if (event !== null) out.push(event)
      }
      return out
    }
    return []
  }

  /** Dispatch a frame → pure map → publish. Never throws into the socket lib. */
  function onUpdate(msg: unknown): void {
    try {
      for (const event of toEvents(msg)) bus.publish(event)
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

  ws.on('update', onUpdate)
  ws.on('reconnect', () => reconnect.markDisconnected())
  ws.on('reconnected', () => reconnect.markReconnected())

  return {
    async subscribe(): Promise<void> {
      await Promise.all(ws.subscribeV5([...TOPICS], CATEGORY, true))
    },
    close(): Promise<void> {
      ws.closeAll()
      return Promise.resolve()
    },
  }
}
