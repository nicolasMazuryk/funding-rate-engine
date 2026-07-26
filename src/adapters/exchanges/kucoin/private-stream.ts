/**
 * KuCoin Futures private (authenticated) account WS stream (`11_execution_and_account_state.md`
 * §7) — the write-side counterpart of the public stream, mirroring `../bitget/private-stream.ts`:
 * same pipeline, same shared reconnect FSM, same three normalized topic families.
 *
 * Three **account-wide** topics on one connection, normalized onto the core event bus:
 *  - **`/contractMarket/tradeOrders`** (subject `symbolOrderChange`) → `OrderUpdate`. `clientOid`
 *    is the engine's `clientOrderId` verbatim (KuCoin's 40-char ceiling is above the core's 36,
 *    `./client-order-id.ts`), so a frame whose id this engine could not have produced is
 *    **dropped**, never guessed.
 *  - **`/contract/positionAll`** → `PositionUpdate` (subject `position.change`) and
 *    `FundingFeeAccrued` (subject `position.settlement`). `currentQty` is **signed** (OKX's
 *    shape, not Bybit/Bitget's absolute-plus-side).
 *  - **`/contractAccount/wallet`** (subject `walletBalance.change`) → `BalanceUpdate`. KuCoin
 *    reports an exact `availableBalance`/`holdBalance` split, so — like Bybit, OKX and Bitget,
 *    unlike Binance — the WS balance is exact rather than approximated.
 *
 * **Why `positionAll` and not `/contract/position:{symbol}`.** KuCoin documents both: a
 * per-symbol position topic and an account-wide one. This adapter deliberately takes the
 * account-wide topic, because {@link PrivateStream.subscribe} takes **no arguments** — it is
 * called once at boot, before any symbol is known. A per-symbol topic would have forced either a
 * subscribe-on-first-submit / unsubscribe-on-flat dance (a second lifecycle to get wrong, racing
 * the fill that closes the position) or a fan-out across the whole shortlist (churning
 * subscriptions on every re-rank). `positionAll` costs one subscription and makes KuCoin behave
 * exactly like its four siblings, which is the point of the port. The topic *matcher* below still
 * accepts the per-symbol echo shape, since the venue's push frames name the concrete symbol.
 *
 * **Funding-fee delivery is the cleanest of the five venues.** Binance and OKX infer the amount
 * from a balance delta; Bitget infers it from a cumulative-`totalFundingFee` delta. KuCoin
 * publishes an **explicit per-settlement `fundingFee`** on `position.settlement`, already
 * attributed to a symbol and stamped with the venue's own `fundingTime` — no inference, no
 * baseline to carry across a reconnect, and a two-position settlement needs no disambiguation.
 *
 * The one thing a fixture cannot settle here is the **sign**. It is taken as credit-positive
 * (the port's convention on {@link FundingFeeAccrued}, and the assumption the Bitget sibling
 * makes for the same reason) and passed through verbatim. KuCoin decommissioned its futures
 * sandbox, so — unlike the demo-account venues — this cannot be confirmed without a real
 * position over a real settlement; the REST `fundingIncome` read is the money truth either way.
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

/** Order lifecycle, account-wide (no per-symbol suffix). Subject: `symbolOrderChange`. */
const TOPIC_ORDERS = '/contractMarket/tradeOrders'
/** Position changes + funding settlement for **every** symbol — see the header on why not `:{symbol}`. */
const TOPIC_POSITIONS = '/contract/positionAll'
/** Wallet balance changes. Subject: `walletBalance.change` (plus two deprecated older subjects). */
const TOPIC_WALLET = '/contractAccount/wallet'

/**
 * Push frames name the concrete symbol (`/contract/position:XBTUSDTM`) even when the
 * subscription was the account-wide `positionAll`, so position frames are matched by prefix.
 */
const POSITION_TOPIC_PREFIX = '/contract/position'

/** REST poll cadence while degraded — well inside the 60 s freshness gate (`00_globals.md` §7). */
const FALLBACK_POLL_MS = 15_000

/** The three private topics the engine needs (`11` §7); all plain strings, all account-wide. */
const TOPICS: readonly string[] = [TOPIC_ORDERS, TOPIC_POSITIONS, TOPIC_WALLET]

/**
 * KuCoin order `type` → engine {@link OrderStatus} (`11` §6). The venue splits what the siblings
 * call a status across two fields: `type` is the *event* (`open` / `match` / `filled` /
 * `canceled` / `update`) and `status` is the coarse book state (`open` / `match` / `done`).
 *
 * `update` is an amend acknowledgement — the order is still resting, so it reads as `OPEN`.
 * There is **no rejected state on the stream**: a rejected order never enters the book, it comes
 * back as a non-zero code on the submit reply. Any unknown `type` is dropped, so a lib or venue
 * change never publishes a bogus terminal state.
 */
const KUCOIN_ORDER_TYPE: Partial<Record<string, OrderStatus>> = {
  open: 'OPEN',
  update: 'OPEN',
  match: 'PARTIAL',
  filled: 'FILLED',
  canceled: 'CANCELLED',
}

/** The two terminal statuses must also carry `status: 'done'`, else the frame is dropped. */
const TERMINAL_STATUSES: readonly OrderStatus[] = ['FILLED', 'CANCELLED']

/** One `symbolOrderChange` payload. Sizes are **integer contract counts** — the engine's own unit. */
export interface KucoinOrderData {
  readonly symbol?: string
  readonly clientOid?: string
  readonly orderId?: string
  /** Event kind: `open` | `match` | `filled` | `canceled` | `update`. */
  readonly type?: string
  /** Book state: `open` | `match` | `done`. */
  readonly status?: string
  readonly side?: string
  readonly orderType?: string
  readonly price?: string
  readonly size?: string
  /** Cumulative filled size, in contracts. */
  readonly filledSize?: string
  readonly remainSize?: string
  readonly canceledSize?: string
  /** Size of *this* match only. */
  readonly matchSize?: string
  /** Price of *this* match — the stream carries no average, see {@link orderDataToOrderUpdate}. */
  readonly matchPrice?: string
  readonly orderTime?: number
  /** **Nanoseconds**, not ms (`./public-stream` sees the same on `ticker`). */
  readonly ts?: number
}

/** One `position.change` payload. `currentQty` is **signed**: negative is short. */
export interface KucoinPositionData {
  readonly symbol?: string
  /** Signed position size, in contracts. */
  readonly currentQty?: number
  readonly markPrice?: number
  readonly avgEntryPrice?: number
  /** `marginChange` | `positionChange` | `liquidation` | `adl` | … — informational only. */
  readonly changeReason?: string
  readonly settleCurrency?: string
}

/** One `position.settlement` payload — the explicit funding-fee frame (see the file header). */
export interface KucoinSettlementData {
  readonly symbol?: string
  /** Settlement time, epoch **ms** (unlike the sibling `ts` field, which is ns). */
  readonly fundingTime?: number
  /** Signed position size at settlement, in contracts. */
  readonly qty?: number
  readonly markPrice?: number
  /** Funding rate as a **fraction** (`-0.000375`), not the engine's signed percent. */
  readonly fundingRate?: number
  /** The settled amount in `settleCurrency`; taken credit-positive (file header). */
  readonly fundingFee?: number
  readonly settleCurrency?: string
  /** **Nanoseconds.** */
  readonly ts?: number
}

/** One `walletBalance.change` payload (the current subject; the deprecated ones are a subset). */
export interface KucoinWalletData {
  readonly currency?: string
  readonly totalBalance?: number | string
  readonly availableBalance?: number | string
  readonly holdBalance?: number | string
  readonly equity?: number | string
  /** Deprecated `orderMargin.change` subject's only figure. */
  readonly orderMargin?: number | string
  readonly timestamp?: number
}

/** A private push frame as it arrives: `{topic, subject, type: 'message', data: {…}}`. */
export interface KucoinPrivateFrame<T> {
  readonly topic?: string
  readonly subject?: string
  readonly type?: string
  readonly data?: T
}

/** Nanosecond venue timestamp → epoch ms; `undefined` when absent/unparsable. */
function nsToMs(raw: unknown): number | undefined {
  const n = num(raw)
  return n === undefined ? undefined : Math.floor(n / 1e6)
}

/** Parse a KuCoin numeric field; `undefined` when absent/empty/unparsable (`""` is not 0). */
function num(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * True when the frame carries a `data` object on a topic this matcher accepts, and — when
 * `subject` is given — that exact subject. `matchTopic` is a predicate rather than a string
 * because position frames arrive under the per-symbol topic spelling (see the file header).
 */
function isFrame<T>(
  msg: unknown,
  matchTopic: (topic: string) => boolean,
  subject?: string,
): msg is KucoinPrivateFrame<T> {
  if (typeof msg !== 'object' || msg === null) return false
  const frame = msg as { topic?: unknown; subject?: unknown; data?: unknown }
  if (typeof frame.topic !== 'string' || !matchTopic(frame.topic)) return false
  if (subject !== undefined && frame.subject !== subject) return false
  return typeof frame.data === 'object' && frame.data !== null
}

/**
 * Map one `symbolOrderChange` payload to an {@link OrderUpdate}, or `null` when the event type
 * has no engine analogue, a terminal type is not confirmed by `status: 'done'`, or `clientOid`
 * is not one of ours (dropped, never guessed).
 *
 * `fillPx` is the **last match price**, not an average: the stream publishes no cumulative
 * average, and inventing one from `matchSize`-weighted arithmetic would be a second source of
 * truth for a figure the REST order read already owns. `qty` is `filledSize`, which *is*
 * cumulative. Both are carried only once there is a fill, so a bare `open` publishes neither.
 */
export function orderDataToOrderUpdate(data: KucoinOrderData): OrderUpdate | null {
  const status = data.type === undefined ? undefined : KUCOIN_ORDER_TYPE[data.type]
  if (status === undefined) return null
  if (TERMINAL_STATUSES.includes(status) && data.status !== 'done') return null
  if (typeof data.clientOid !== 'string' || data.clientOid.length === 0) return null
  const clientOrderId = fromVenueClientOid(data.clientOid)
  if (clientOrderId === undefined) return null

  const filled = num(data.filledSize) ?? 0
  const matchPrice = num(data.matchPrice) ?? 0
  return {
    type: 'OrderUpdate',
    clientOrderId,
    status,
    ...(matchPrice > 0 ? { fillPx: matchPrice } : {}),
    ...(filled > 0 ? { qty: filled } : {}),
  }
}

/**
 * Map one `position.change` payload to a {@link PositionUpdate}; `null` when the symbol does not
 * resolve. `currentQty` is signed (negative is short) and already in contracts — the engine's
 * own sizing unit on this venue (`./instrument.ts`). A flat position reads as `long` at qty 0,
 * matching the siblings and the position tracker's expectation.
 */
export function positionDataToPositionUpdate(
  data: KucoinPositionData,
  resolveCanonical: (venueSymbol: string) => string | undefined,
): PositionUpdate | null {
  if (typeof data.symbol !== 'string') return null
  const symbol = resolveCanonical(data.symbol)
  if (symbol === undefined) return null
  const qty = num(data.currentQty) ?? 0
  return { type: 'PositionUpdate', symbol, qty: Math.abs(qty), side: qty < 0 ? 'short' : 'long' }
}

/**
 * Map one `position.settlement` payload to a {@link FundingFeeAccrued}; `null` when the symbol
 * does not resolve or the venue sent no amount. The amount is the venue's **explicit**
 * `fundingFee` — no delta, no inference (file header) — passed through as credit-positive.
 *
 * `fundingTime` is the venue's own settlement stamp in ms; `ts` (nanoseconds) and the clock are
 * the fallbacks, in that order. ±30 s `11` §7 vs the normative ±5 s: the tolerance is the
 * funding gate's (0290); this adapter only delivers a faithful `fundingTime`.
 */
export function settlementDataToFundingFee(
  data: KucoinSettlementData,
  resolveCanonical: (venueSymbol: string) => string | undefined,
  now: () => number,
): FundingFeeAccrued | null {
  if (typeof data.symbol !== 'string') return null
  const amount = num(data.fundingFee)
  if (amount === undefined) return null
  const symbol = resolveCanonical(data.symbol)
  if (symbol === undefined) return null
  return { type: 'FundingFeeAccrued', symbol, amount, fundingTime: num(data.fundingTime) ?? nsToMs(data.ts) ?? now() }
}

/**
 * Map one `walletBalance.change` payload to a {@link BalanceUpdate}. KuCoin gives an exact split:
 * `free = availableBalance`, and `used = holdBalance` when present, else `max(0, total − free)`.
 * The deprecated `orderMargin.change` subject carries only `orderMargin`, which is the same
 * "held" figure, so it is accepted as the `used` fallback.
 */
export function walletDataToBalanceUpdate(data: KucoinWalletData): BalanceUpdate | null {
  if (typeof data.currency !== 'string' || data.currency.length === 0) return null
  const total = num(data.totalBalance) ?? num(data.equity) ?? 0
  const free = num(data.availableBalance) ?? total
  const used = num(data.holdBalance) ?? num(data.orderMargin) ?? Math.max(0, total - free)
  return { type: 'BalanceUpdate', asset: data.currency, free, used }
}

/** The slice of the native credentialed `WebsocketClient` the private stream uses. */
export interface KucoinPrivateWsClient {
  /** **Synchronous** on this SDK (returns `void`, unlike the Bybit/OKX/Bitget siblings). */
  subscribe(topics: string[], wsKey: string): void
  on(event: string, listener: (arg: unknown) => void): unknown
  closeAll(force?: boolean): void
}

export interface KucoinPrivateStreamDeps {
  readonly ws: KucoinPrivateWsClient
  readonly bus: EventBus
  readonly clock: Clock
  /** The lib's connection key for the futures private socket (`WS_KEY_MAP.futuresPrivateV1`). */
  readonly wsKey: string
  /** Venue symbol → canonical name off the live registry (`XBTUSDTM` → `BTC`), else `undefined`. */
  resolveCanonical(venueSymbol: string): string | undefined
  /** REST account-wide positions — the reprime + degraded-poll ground truth. */
  restPositions(): Promise<Position[]>
  /** REST balance (authoritative free/used) — reprime + degraded-poll. */
  restBalance(): Promise<Balance>
  /** REST open orders — reprime only (fills can't be polled cheaply). */
  restOpenOrders(): Promise<Order[]>
  /**
   * Record the venue symbol seen on an order frame so the adapter's `getOrder`/`cancel` can
   * resolve the symbol KuCoin's order read requires from a `clientOrderId`. The WS-API order
   * path populates this authoritatively at submit time; the stream keeps it warm from live
   * events.
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

export function createKucoinPrivateStream(deps: KucoinPrivateStreamDeps): PrivateStream {
  const { ws, bus, clock, wsKey, resolveCanonical, restPositions, restBalance, restOpenOrders, recordOrderSymbol } =
    deps

  /** Fan one frame out to its engine events (pure per payload), in topic order. */
  function toEvents(msg: unknown): EngineEvent[] {
    if (isFrame<KucoinOrderData>(msg, (topic) => topic === TOPIC_ORDERS, 'symbolOrderChange')) {
      const data = msg.data ?? {}
      const event = orderDataToOrderUpdate(data)
      if (event === null) return []
      if (typeof data.symbol === 'string') recordOrderSymbol(event.clientOrderId, data.symbol)
      return [event]
    }
    const isPosition = (topic: string): boolean => topic.startsWith(POSITION_TOPIC_PREFIX)
    if (isFrame<KucoinPositionData>(msg, isPosition, 'position.change')) {
      const event = positionDataToPositionUpdate(msg.data ?? {}, resolveCanonical)
      return event === null ? [] : [event]
    }
    if (isFrame<KucoinSettlementData>(msg, isPosition, 'position.settlement')) {
      const event = settlementDataToFundingFee(msg.data ?? {}, resolveCanonical, clock.now)
      return event === null ? [] : [event]
    }
    if (isFrame<KucoinWalletData>(msg, (topic) => topic === TOPIC_WALLET)) {
      const event = walletDataToBalanceUpdate(msg.data ?? {})
      return event === null ? [] : [event]
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
  // Nothing to reset on disconnect either: the funding amount is per-settlement, so — unlike
  // the Bitget sibling's delta baseline — no cross-outage state can go stale here.
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
    subscribe(): Promise<void> {
      // Synchronous on this SDK: the lib queues the topics and (re)sends them on every connect.
      ws.subscribe([...TOPICS], wsKey)
      return Promise.resolve()
    },
    close(): Promise<void> {
      ws.closeAll()
      return Promise.resolve()
    },
  }
}
