/**
 * OKX private (authenticated) account WS stream (`11_execution_and_account_state.md` §7) —
 * the write-side counterpart of the public stream, mirroring `../bybit/private-stream.ts`:
 * same pipeline, same shared reconnect FSM.
 *
 * Four channels on one connection, normalized onto the core event bus:
 *  - **`orders`** (`instType: 'ANY'`) → `OrderUpdate`. `clOrdId` is our `clientOrderId`
 *    re-spelled for OKX's alphanumeric-only key (`./client-order-id.ts`), so it is decoded
 *    back before publish; a frame whose id this codec did not produce is **dropped**.
 *  - **`positions`** → `PositionUpdate`. In one-way mode `posSide` is `net` and `pos` is
 *    **signed** (negative = short), unlike Bybit's absolute size plus a `Buy`/`Sell` field.
 *  - **`account`** → `BalanceUpdate`, one per currency. OKX reports a real
 *    `availBal`/`frozenBal` split, so — like Bybit and unlike Binance — the WS balance is
 *    exact rather than approximated.
 *  - **`balance_and_position`** → `FundingFeeAccrued`, and nothing else (positions already
 *    arrive on their own channel). See below.
 *
 * **Funding-fee delivery is this venue's highest-risk mapping** (it was on Bybit too, for the
 * same reason: it is the one fact a fixture cannot settle). OKX has no funding-specific
 * private channel and no funding row on `orders`. What it has is `balance_and_position` with
 * `eventType: 'funding_fee'` — but that frame carries `balData[].cashBal`, an **absolute**
 * balance, not a delta. So the amount is inferred from the change in the settle currency's
 * `cashBal` since the previous frame, which is the same shape as the Binance sibling
 * (`ACCOUNT_UPDATE` + matching quote-asset balance change) and the opposite of Bybit's
 * explicit `execFee`. A settlement that *reduces* cash yields a negative delta, which is
 * already the port's credit-positive convention — no negation, unlike Bybit.
 *
 * Attribution is deliberately conservative: the event is published **only when exactly one
 * `posData` row resolves to a known symbol**. A funding settlement that touches two positions
 * arrives as one frame with one cash delta, and splitting it would be a guess; the funding
 * gate's REST safety net (`adapter.ts`'s `fundingIncome`, account bills type `8`, implemented
 * for real on this venue) covers that case. The testnet tier records which path actually
 * fired (`17` §3).
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
import { fromVenueClOrdId } from './client-order-id.js'
import type { OkxChannelArg } from './public-stream.js'

/** Settle/quote currency of the linear USDT-perp universe — the funding-fee cash delta reads it. */
const SETTLE_CCY = 'USDT'
/** `balance_and_position` event type that marks a funding settlement. */
const FUNDING_FEE_EVENT = 'funding_fee'
/** REST poll cadence while degraded — well inside the 60 s freshness gate (`00_globals.md` §7). */
const FALLBACK_POLL_MS = 15_000

/**
 * The four private channels the engine needs (`11` §7). `instType: 'ANY'` on the two
 * instrument-scoped ones covers the whole account without enumerating symbols.
 */
const CHANNELS: readonly OkxChannelArg[] = [
  { channel: 'orders', instType: 'ANY' },
  { channel: 'positions', instType: 'ANY' },
  { channel: 'account' },
  { channel: 'balance_and_position' },
]

/**
 * OKX `state` → engine {@link OrderStatus} (`11` §6). OKX has **no rejected state on the
 * stream**: a rejected order never enters the book — it comes back as a non-zero `sCode` on
 * the submit reply, which `./ws-orders.ts` turns into a mapped throw. Any unknown state is
 * dropped, so a lib or venue change never publishes a bogus terminal state.
 */
const OKX_ORDER_STATE: Partial<Record<string, OrderStatus>> = {
  live: 'OPEN',
  partially_filled: 'PARTIAL',
  filled: 'FILLED',
  canceled: 'CANCELLED',
  mmp_canceled: 'CANCELLED',
}

/** One `orders` row (raw venue shape — every value is a string). */
export interface OkxOrderRow {
  readonly instId?: string
  readonly clOrdId?: string
  readonly ordId?: string
  readonly state?: string
  /** Cumulative filled quantity, in contracts. */
  readonly accFillSz?: string
  /** Average fill price over the filled quantity. */
  readonly avgPx?: string
}

/** One `positions` row. `pos` is signed in one-way (`net`) mode. */
export interface OkxPositionRow {
  readonly instId?: string
  readonly pos?: string
  readonly posSide?: string
  readonly avgPx?: string
}

/** One `account` row: an equity snapshot with a per-currency `details` array. */
export interface OkxAccountRow {
  readonly details?: readonly {
    readonly ccy?: string
    readonly availBal?: string
    readonly availEq?: string
    readonly frozenBal?: string
    readonly cashBal?: string
    readonly eq?: string
  }[]
}

/** One `balance_and_position` row — the funding-fee carrier. */
export interface OkxBalancePositionRow {
  readonly eventType?: string
  /** Push time, epoch ms as a string. */
  readonly pTime?: string
  readonly balData?: readonly { readonly ccy?: string; readonly cashBal?: string }[]
  readonly posData?: readonly { readonly instId?: string }[]
}

/** A private push frame as it arrives: `{arg: {channel, …}, data: [row, …]}`. */
export interface OkxPrivateFrame<T> {
  readonly arg?: { readonly channel?: string }
  readonly data?: readonly T[]
}

/** Parse an OKX numeric string field; `undefined` when absent/empty/unparsable (`""` is not 0). */
function num(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/** True when the frame is the named private channel carrying a data array. */
function isFrame<T>(msg: unknown, channel: string): msg is OkxPrivateFrame<T> {
  if (typeof msg !== 'object' || msg === null) return false
  const arg = (msg as { arg?: unknown }).arg
  if (typeof arg !== 'object' || arg === null || (arg as { channel?: unknown }).channel !== channel) return false
  return Array.isArray((msg as { data?: unknown }).data)
}

/**
 * Map one `orders` row to an {@link OrderUpdate}, or `null` when the state has no engine
 * analogue or `clOrdId` is not one of ours (dropped, never guessed). `fillPx`/`qty` are
 * carried only once there is a fill, so a bare `live` publishes neither.
 */
export function orderRowToOrderUpdate(row: OkxOrderRow): OrderUpdate | null {
  const status = row.state === undefined ? undefined : OKX_ORDER_STATE[row.state]
  if (status === undefined) return null
  if (typeof row.clOrdId !== 'string' || row.clOrdId.length === 0) return null
  const clientOrderId = fromVenueClOrdId(row.clOrdId)
  if (clientOrderId === undefined) return null

  const filled = num(row.accFillSz) ?? 0
  const avg = num(row.avgPx) ?? 0
  return {
    type: 'OrderUpdate',
    clientOrderId,
    status,
    ...(avg > 0 ? { fillPx: avg } : {}),
    ...(filled > 0 ? { qty: filled } : {}),
  }
}

/**
 * Map one `positions` row to a {@link PositionUpdate}; `null` when the symbol does not
 * resolve. In one-way mode `posSide` is `net` and the direction lives in the **sign** of
 * `pos`; a flat position reads as `long` at qty 0, matching the siblings and the position
 * tracker's expectation.
 */
export function positionRowToPositionUpdate(
  row: OkxPositionRow,
  resolveCanonical: (venueSymbol: string) => string | undefined,
): PositionUpdate | null {
  if (typeof row.instId !== 'string') return null
  const symbol = resolveCanonical(row.instId)
  if (symbol === undefined) return null
  const pos = num(row.pos) ?? 0
  const side = row.posSide === 'short' || (row.posSide !== 'long' && pos < 0) ? 'short' : 'long'
  return { type: 'PositionUpdate', symbol, qty: Math.abs(pos), side }
}

/**
 * Map one `account` row to a {@link BalanceUpdate} per currency. OKX gives an exact split:
 * `free = availBal` (falling back to `availEq`, then the cash balance), and
 * `used = frozenBal` when present, else `max(0, cashBal − free)`.
 */
export function accountRowToBalanceUpdates(row: OkxAccountRow): BalanceUpdate[] {
  const out: BalanceUpdate[] = []
  for (const detail of row.details ?? []) {
    if (typeof detail.ccy !== 'string' || detail.ccy.length === 0) continue
    const cash = num(detail.cashBal) ?? num(detail.eq) ?? 0
    const free = num(detail.availBal) ?? num(detail.availEq) ?? cash
    const used = num(detail.frozenBal) ?? Math.max(0, cash - free)
    out.push({ type: 'BalanceUpdate', asset: detail.ccy, free, used })
  }
  return out
}

/** The settle-currency cash balance carried by a `balance_and_position` row, if any. */
export function settleCashBalance(row: OkxBalancePositionRow): number | undefined {
  for (const bal of row.balData ?? []) {
    if (bal.ccy === SETTLE_CCY) return num(bal.cashBal)
  }
  return undefined
}

/**
 * Map one `balance_and_position` row to a {@link FundingFeeAccrued}, or `null`. See the file
 * header for why the amount is a **cash-balance delta** rather than a venue-supplied figure,
 * and why exactly one resolvable position is required.
 *
 * `previousCashBalance` is the settle-currency `cashBal` from the last frame; `undefined`
 * (first frame after connect/reconnect) means no delta can be computed and nothing is
 * published — the REST `fundingIncome` read is the gate's ground truth in that window.
 *
 * ±30 s `11` §7 vs the normative ±5 s: the tolerance is the funding gate's (0290); this
 * adapter only delivers a faithful `fundingTime`.
 */
export function balancePositionRowToFundingFee(
  row: OkxBalancePositionRow,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  previousCashBalance: number | undefined,
  now: () => number,
): FundingFeeAccrued | null {
  if (row.eventType !== FUNDING_FEE_EVENT) return null
  if (previousCashBalance === undefined) return null
  const cash = settleCashBalance(row)
  if (cash === undefined) return null

  const symbols = (row.posData ?? [])
    .map((p) => (typeof p.instId === 'string' ? resolveCanonical(p.instId) : undefined))
    .filter((s): s is string => s !== undefined)
  const symbol = symbols.length === 1 ? symbols[0] : undefined
  if (symbol === undefined) return null

  const amount = cash - previousCashBalance
  if (amount === 0) return null
  // Credit-positive already: a settlement the account paid shrinks `cashBal`.
  return { type: 'FundingFeeAccrued', symbol, amount, fundingTime: num(row.pTime) ?? now() }
}

/** The slice of the native credentialed `WebsocketClient` the private stream uses. */
export interface OkxPrivateWsClient {
  subscribe(args: OkxChannelArg[] | OkxChannelArg, isPrivateTopic?: boolean): Promise<unknown>[]
  on(event: string, listener: (arg: unknown) => void): unknown
  closeAll(force?: boolean): void
}

export interface OkxPrivateStreamDeps {
  readonly ws: OkxPrivateWsClient
  readonly bus: EventBus
  readonly clock: Clock
  /** Venue id → canonical name off the live registry (`BTC-USDT-SWAP` → `BTC`), else `undefined`. */
  resolveCanonical(venueSymbol: string): string | undefined
  /** REST account-wide positions — the reprime + degraded-poll ground truth. */
  restPositions(): Promise<Position[]>
  /** REST balance (authoritative free/used) — reprime + degraded-poll. */
  restBalance(): Promise<Balance>
  /** REST open orders — reprime only (fills can't be polled cheaply). */
  restOpenOrders(): Promise<Order[]>
  /**
   * Record the `instId` seen on an `orders` frame so the adapter's `getOrder`/`cancel` can
   * resolve the symbol OKX requires from a `clientOrderId`. `ws-orders.ts` populates this
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

export function createOkxPrivateStream(deps: OkxPrivateStreamDeps): PrivateStream {
  const { ws, bus, clock, resolveCanonical, restPositions, restBalance, restOpenOrders, recordOrderSymbol } = deps

  // Last settle-currency `cashBal` seen on a `balance_and_position` frame — the funding-fee
  // delta's baseline. Cleared on disconnect so a stale pre-drop balance never produces a
  // phantom credit spanning the outage (the reprime + REST income read cover that window).
  let lastCashBalance: number | undefined

  /** Fan one frame out to its engine events (pure per row), in channel order. */
  function toEvents(msg: unknown): EngineEvent[] {
    if (isFrame<OkxOrderRow>(msg, 'orders')) {
      const out: EngineEvent[] = []
      for (const row of msg.data ?? []) {
        const event = orderRowToOrderUpdate(row)
        if (event === null) continue
        if (typeof row.instId === 'string') recordOrderSymbol(event.clientOrderId, row.instId)
        out.push(event)
      }
      return out
    }
    if (isFrame<OkxPositionRow>(msg, 'positions')) {
      const out: EngineEvent[] = []
      for (const row of msg.data ?? []) {
        const event = positionRowToPositionUpdate(row, resolveCanonical)
        if (event !== null) out.push(event)
      }
      return out
    }
    if (isFrame<OkxAccountRow>(msg, 'account')) {
      return (msg.data ?? []).flatMap((row) => accountRowToBalanceUpdates(row))
    }
    if (isFrame<OkxBalancePositionRow>(msg, 'balance_and_position')) {
      const out: EngineEvent[] = []
      for (const row of msg.data ?? []) {
        const event = balancePositionRowToFundingFee(row, resolveCanonical, lastCashBalance, clock.now)
        // Advance the baseline on **every** frame, funding or not, so the next settlement's
        // delta measures one settlement and not an accumulation of trades since the last one.
        lastCashBalance = settleCashBalance(row) ?? lastCashBalance
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
      lastCashBalance = undefined // the funding delta must not span the outage
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
      await Promise.all(ws.subscribe([...CHANNELS], true))
    },
    close(): Promise<void> {
      ws.closeAll()
      return Promise.resolve()
    },
  }
}
