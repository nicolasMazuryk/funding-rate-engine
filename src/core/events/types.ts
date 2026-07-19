/**
 * The event spine (`08_system_overview.md` §4).
 *
 * Every input to the pure core is one of these eight immutable value objects,
 * produced by the exchange adapters at the edges; every output is an intent/command.
 * The union is closed and discriminated on `type` so downstream switches are
 * exhaustiveness-checked (see {@link ./types.test.ts} and `assertNever`).
 *
 * Units follow `00_globals.md` §1.2 (load-bearing): `rate` is **signed percent**
 * (`-0.4` = −0.40% per settlement); all timestamps are **epoch milliseconds, UTC**
 * (`number`, suffixed `Ts`/`Time`). See per-field doc comments.
 */

import type { OrderStatus, Side } from '../ports/exchange-adapter.js'

/** Which timer fired (`12_strategy_runtime_and_intent_lifecycle.md` §1 scheduler table). */
export type TimerKind = 'scan' | 'entry' | 'deadline'

/**
 * A scheduler timer. `scan` is hourly/global (HH:58); `entry`/`deadline` are
 * per-candidate/per-intent and carry the relevant `symbol`/`intentId`.
 */
export interface Timer {
  readonly type: 'Timer'
  readonly kind: TimerKind
  /** Fire time, epoch ms UTC. */
  readonly ts: number
  readonly symbol?: string
  readonly intentId?: string
}

/** Predicted funding observed before settlement (public WS / REST poll). */
export interface FundingPredicted {
  readonly type: 'FundingPredicted'
  readonly symbol: string
  /** Predicted funding rate, signed percent (`00_globals.md` §1.1 `F`). */
  readonly rate: number
  /** Observation time, epoch ms UTC. */
  readonly ts: number
}

/** Settled funding rate, read after `T_settle`. */
export interface FundingSettled {
  readonly type: 'FundingSettled'
  readonly symbol: string
  /** Settled funding rate, signed percent (`00_globals.md` §1.1 `F`). */
  readonly rate: number
  /** `T_settle`, epoch ms UTC (`00_globals.md` §1.1). */
  readonly settleTs: number
}

/** Funding fee actually credited/charged (private WS `funding_fee` event, marks `T_drop`). */
export interface FundingFeeAccrued {
  readonly type: 'FundingFeeAccrued'
  readonly symbol: string
  /**
   * Funding amount in **quote currency** (USDT) as reported by the venue's
   * `funding_fee` event; signed (credit positive, charge negative). Distinct
   * from the signed-percent rate on {@link FundingSettled} (`00_globals.md` §1.1 `T_drop`).
   */
  readonly amount: number
  /** `T_drop`, epoch ms UTC (±5 s tolerance vs `T_settle`, `00_globals.md` §1.1). */
  readonly fundingTime: number
}

/** Last-price / trade tick (public WS). */
export interface MarketTick {
  readonly type: 'MarketTick'
  readonly symbol: string
  readonly price: number
  /** Tick time, epoch ms UTC. */
  readonly ts: number
}

/** Order lifecycle update (private WS, REST fallback) — drives the order FSM (`11` §6). */
export interface OrderUpdate {
  readonly type: 'OrderUpdate'
  readonly clientOrderId: string
  readonly status: OrderStatus
  readonly fillPx?: number
  readonly qty?: number
}

/** Position change (private WS, REST reconcile). */
export interface PositionUpdate {
  readonly type: 'PositionUpdate'
  readonly symbol: string
  readonly qty: number
  readonly side: Side
}

/** Balance change (private WS). */
export interface BalanceUpdate {
  readonly type: 'BalanceUpdate'
  readonly asset: string
  readonly free: number
  readonly used: number
}

/** The closed, discriminated event union that drives the core (`08` §4). */
export type EngineEvent =
  | Timer
  | FundingPredicted
  | FundingSettled
  | FundingFeeAccrued
  | MarketTick
  | OrderUpdate
  | PositionUpdate
  | BalanceUpdate

/** The `type` tag of any {@link EngineEvent}. */
export type EngineEventType = EngineEvent['type']

/**
 * Exhaustiveness guard for closed switches over {@link EngineEvent} (and any
 * other discriminated union). Reaching it is a compile error if a variant is
 * unhandled, and a thrown error if an impossible value arrives at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`)
}
