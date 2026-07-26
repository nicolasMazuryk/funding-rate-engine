/**
 * Bitget private (authenticated) account WS stream (`11_execution_and_account_state.md` §7) —
 * the write-side counterpart of the public stream, mirroring `../okx/private-stream.ts`: same
 * pipeline, same shared reconnect FSM.
 *
 * Three UTA topics on one connection, normalized onto the core event bus:
 *  - **`order`** → `OrderUpdate`. `clientOid` is the engine's `clientOrderId` verbatim (Bitget's
 *    charset accepts it; only the 32-char ceiling is enforced, `./client-order-id.ts`), so a
 *    frame whose id this engine could not have produced is **dropped**, never guessed.
 *  - **`position`** → `PositionUpdate`. `size` is **absolute** with the direction in `posSide`
 *    (Bybit's shape, not OKX's signed `pos`).
 *  - **`account`** → `BalanceUpdate`, one per coin. Bitget reports an exact
 *    `available`/`locked` split, so — like Bybit and OKX, unlike Binance — the WS balance is
 *    exact rather than approximated.
 *
 * The **`fill`** topic is deliberately not subscribed. It carries per-execution rows, and the
 * engine's order FSM is driven by cumulative state (`cumExecQty` / `avgPrice`), which the
 * `order` topic already publishes on every fill — a second stream of the same information
 * would be two sources of truth for one FSM. The captured `private-ws` fixture set still
 * records it, so adding it later is a mapping, not an investigation.
 *
 * **Funding-fee delivery is this venue's highest-risk mapping** (it was on Bybit and OKX too,
 * for the same reason: it is the one fact a fixture cannot settle). Bitget publishes no
 * funding-specific private topic and no funding row on `order`. What it does publish is
 * `totalFundingFee` on every **position** row — the position's *cumulative* funding — so one
 * settlement is the **change** in that figure between two frames. That is strictly better than
 * the balance-delta inference the Binance and OKX siblings fall back on: it is already
 * attributed to a symbol, so a settlement touching two positions needs no guessing.
 *
 * Two things about it are unverified until the demo account settles a funding period (task 0440
 * Phase 2 `2b`): whether Bitget pushes a position frame at settlement at all, and the **sign**
 * convention of `totalFundingFee`. It is assumed credit-positive here (matching the port), and
 * `adapter.ts`'s REST `fundingIncome` — a real implementation on this venue, via ccxt's UTA
 * `fetchFundingHistory` — is the money truth either way.
 *
 * Auth, keepalive, reconnect and resubscribe are owned by the native lib (KISS). Our shared
 * {@link ReconnectController} sits on top: while the socket is down a REST poll keeps
 * positions/balances fresh, and on reconnect we re-prime a full snapshot (positions →
 * balances → open orders) before trusting the WS again.
 */

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
import { fromVenueClientOid } from './client-order-id.js'
import type { BitgetTopicRequest } from './public-stream.js'

/** Product type on every private UTA topic — account-wide, so no symbol enumeration. */
const PRIVATE_INST_TYPE = 'UTA'
/** REST poll cadence while degraded — well inside the 60 s freshness gate (`00_globals.md` §7). */
const FALLBACK_POLL_MS = 15_000

/** The three private topics the engine needs (`11` §7); see the header on why `fill` is absent. */
const TOPICS: readonly BitgetTopicRequest[] = [
  { topic: 'order', payload: { instType: PRIVATE_INST_TYPE } },
  { topic: 'position', payload: { instType: PRIVATE_INST_TYPE } },
  { topic: 'account', payload: { instType: PRIVATE_INST_TYPE } },
]

/**
 * Bitget `orderStatus` → engine {@link OrderStatus} (`11` §6). Bitget has **no rejected state
 * on the stream**: a rejected order never enters the book — it comes back as a non-zero code on
 * the submit reply, which `./ws-orders.ts` turns into a mapped throw. Any unknown status is
 * dropped, so a lib or venue change never publishes a bogus terminal state.
 *
 * Both `cancelled` (the docs' spelling on the order channel) and `canceled` (the REST spelling)
 * are listed: the venue is inconsistent across surfaces and either would otherwise be dropped.
 */
const BITGET_ORDER_STATUS: Partial<Record<string, OrderStatus>> = {
  new: 'OPEN',
  live: 'OPEN',
  partially_filled: 'PARTIAL',
  filled: 'FILLED',
  cancelled: 'CANCELLED',
  canceled: 'CANCELLED',
}

/** One `order` row (raw venue shape — every value is a string). */
export interface BitgetOrderRow {
  readonly symbol?: string
  readonly clientOid?: string
  readonly orderId?: string
  readonly orderStatus?: string
  /** Cumulative executed quantity, in base units. */
  readonly cumExecQty?: string
  /** Average execution price over the filled quantity. */
  readonly avgPrice?: string
}

/** One `position` row. `size` is absolute; the direction is `posSide`. */
export interface BitgetPositionRow {
  readonly symbol?: string
  readonly size?: string
  readonly posSide?: string
  readonly avgPrice?: string
  /** Cumulative funding paid/received on this position — the funding-fee delta's source. */
  readonly totalFundingFee?: string
  readonly updatedTime?: string
}

/** One `account` row: an equity snapshot with a per-coin array. */
export interface BitgetAccountRow {
  readonly coin?: readonly {
    readonly coin?: string
    readonly available?: string
    readonly locked?: string
    readonly frozen?: string
    readonly balance?: string
    readonly equity?: string
  }[]
}

/** A private push frame as it arrives: `{arg: {instType, topic}, data: [row, …], ts}`. */
export interface BitgetPrivateFrame<T> {
  readonly arg?: { readonly topic?: string; readonly instType?: string }
  readonly action?: string
  readonly ts?: number
  readonly data?: readonly T[]
}

/** Parse a Bitget numeric string field; `undefined` when absent/empty/unparsable (`""` is not 0). */
function num(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** True when the frame is the named private topic carrying a data array. */
function isFrame<T>(msg: unknown, topic: string): msg is BitgetPrivateFrame<T> {
  if (typeof msg !== 'object' || msg === null) return false
  const arg = (msg as { arg?: unknown }).arg
  if (typeof arg !== 'object' || arg === null || (arg as { topic?: unknown }).topic !== topic) return false
  return Array.isArray((msg as { data?: unknown }).data)
}

/**
 * Map one `order` row to an {@link OrderUpdate}, or `null` when the status has no engine
 * analogue or `clientOid` is not one of ours (dropped, never guessed). `fillPx`/`qty` are
 * carried only once there is a fill, so a bare `live` publishes neither.
 */
export function orderRowToOrderUpdate(row: BitgetOrderRow): OrderUpdate | null {
  const status = row.orderStatus === undefined ? undefined : BITGET_ORDER_STATUS[row.orderStatus]
  if (status === undefined) return null
  if (typeof row.clientOid !== 'string' || row.clientOid.length === 0) return null
  const clientOrderId = fromVenueClientOid(row.clientOid)
  if (clientOrderId === undefined) return null

  const filled = num(row.cumExecQty) ?? 0
  const avg = num(row.avgPrice) ?? 0
  return {
    type: 'OrderUpdate',
    clientOrderId,
    status,
    ...(avg > 0 ? { fillPx: avg } : {}),
    ...(filled > 0 ? { qty: filled } : {}),
  }
}

/**
 * Map one `position` row to a {@link PositionUpdate}; `null` when the symbol does not resolve.
 * `size` is absolute and `posSide` carries the direction; a flat position reads as `long` at
 * qty 0, matching the siblings and the position tracker's expectation.
 */
export function positionRowToPositionUpdate(
  row: BitgetPositionRow,
  resolveCanonical: (venueSymbol: string) => string | undefined,
): PositionUpdate | null {
  if (typeof row.symbol !== 'string') return null
  const symbol = resolveCanonical(row.symbol)
  if (symbol === undefined) return null
  const size = num(row.size) ?? 0
  return { type: 'PositionUpdate', symbol, qty: Math.abs(size), side: row.posSide === 'short' ? 'short' : 'long' }
}

/**
 * Map one `account` row to a {@link BalanceUpdate} per coin. Bitget gives an exact split:
 * `free = available`, and `used = locked` (the venue also spells it `frozen` on some surfaces)
 * when present, else `max(0, balance − free)`.
 */
export function accountRowToBalanceUpdates(row: BitgetAccountRow): BalanceUpdate[] {
  const out: BalanceUpdate[] = []
  for (const detail of row.coin ?? []) {
    if (typeof detail.coin !== 'string' || detail.coin.length === 0) continue
    const total = num(detail.balance) ?? num(detail.equity) ?? 0
    const free = num(detail.available) ?? total
    const used = num(detail.locked) ?? num(detail.frozen) ?? Math.max(0, total - free)
    out.push({ type: 'BalanceUpdate', asset: detail.coin, free, used })
  }
  return out
}

/**
 * Map one `position` row to a {@link FundingFeeAccrued}, or `null`. See the file header for why
 * the amount is a **`totalFundingFee` delta** rather than a venue-supplied per-settlement figure.
 *
 * `previousTotal` is the same position's `totalFundingFee` from the last frame; `undefined`
 * (first frame after connect/reconnect) means no delta can be computed and nothing is published
 * — the REST `fundingIncome` read is the gate's ground truth in that window.
 *
 * ±30 s `11` §7 vs the normative ±5 s: the tolerance is the funding gate's (0290); this adapter
 * only delivers a faithful `fundingTime`.
 */
export function positionRowToFundingFee(
  row: BitgetPositionRow,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  previousTotal: number | undefined,
  now: () => number,
): FundingFeeAccrued | null {
  if (typeof row.symbol !== 'string') return null
  if (previousTotal === undefined) return null
  const total = num(row.totalFundingFee)
  if (total === undefined) return null
  const symbol = resolveCanonical(row.symbol)
  if (symbol === undefined) return null

  const amount = total - previousTotal
  if (amount === 0) return null
  // Credit-positive already, assuming Bitget accumulates received funding positively — the
  // assumption Phase 2 validates against the REST funding history before it is trusted.
  return { type: 'FundingFeeAccrued', symbol, amount, fundingTime: num(row.updatedTime) ?? now() }
}

/** The slice of the native credentialed `WebsocketClientV3` the private stream uses. */
export interface BitgetPrivateWsClient {
  subscribe(requests: BitgetTopicRequest[], wsKey: string): Promise<unknown>
  on(event: string, listener: (arg: unknown) => void): unknown
  closeAll(force?: boolean): void
}

export interface BitgetPrivateStreamDeps {
  readonly ws: BitgetPrivateWsClient
  readonly bus: EventBus
  readonly clock: Clock
  /** The lib's connection key for the private v3 socket (`WS_KEY_MAP.v3Private`). */
  readonly wsKey: string
  /** Venue symbol → canonical name off the live registry (`1000BONKUSDT` → `BONK`), else `undefined`. */
  resolveCanonical(venueSymbol: string): string | undefined
  /** REST account-wide positions — the reprime + degraded-poll ground truth. */
  restPositions(): Promise<Position[]>
  /** REST balance (authoritative free/used) — reprime + degraded-poll. */
  restBalance(): Promise<Balance>
  /** REST open orders — reprime only (fills can't be polled cheaply). */
  restOpenOrders(): Promise<Order[]>
  /**
   * Record the venue symbol seen on an `order` frame so the adapter's `getOrder`/`cancel` can
   * resolve the symbol Bitget's order read requires from a `clientOrderId`. `ws-orders.ts`
   * populates this authoritatively at submit time; the stream keeps it warm from live events.
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

export function createBitgetPrivateStream(deps: BitgetPrivateStreamDeps): PrivateStream {
  const { ws, bus, clock, wsKey, resolveCanonical, restPositions, restBalance, restOpenOrders, recordOrderSymbol } =
    deps

  // Last `totalFundingFee` seen per venue symbol — the funding-fee delta's baseline. Cleared on
  // disconnect so a stale pre-drop total never produces a phantom credit spanning the outage
  // (the reprime + REST income read cover that window).
  let fundingTotals = new Map<string, number>()

  /** Fan one frame out to its engine events (pure per row), in topic order. */
  function toEvents(msg: unknown): EngineEvent[] {
    if (isFrame<BitgetOrderRow>(msg, 'order')) {
      const out: EngineEvent[] = []
      for (const row of msg.data ?? []) {
        const event = orderRowToOrderUpdate(row)
        if (event === null) continue
        if (typeof row.symbol === 'string') recordOrderSymbol(event.clientOrderId, row.symbol)
        out.push(event)
      }
      return out
    }
    if (isFrame<BitgetPositionRow>(msg, 'position')) {
      const out: EngineEvent[] = []
      for (const row of msg.data ?? []) {
        const position = positionRowToPositionUpdate(row, resolveCanonical)
        if (position !== null) out.push(position)
        if (typeof row.symbol !== 'string') continue
        const funding = positionRowToFundingFee(row, resolveCanonical, fundingTotals.get(row.symbol), clock.now)
        // Advance the baseline on **every** frame, funding or not, so the next settlement's
        // delta measures one settlement and not an accumulation since the last one.
        const total = num(row.totalFundingFee)
        if (total !== undefined) fundingTotals.set(row.symbol, total)
        if (funding !== null) out.push(funding)
      }
      return out
    }
    if (isFrame<BitgetAccountRow>(msg, 'account')) {
      return (msg.data ?? []).flatMap((row) => accountRowToBalanceUpdates(row))
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
      fundingTotals = new Map() // the funding delta must not span the outage
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
      await ws.subscribe([...TOPICS], wsKey)
    },
    close(): Promise<void> {
      ws.closeAll()
      return Promise.resolve()
    },
  }
}
