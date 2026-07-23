/**
 * Shared S6 composition + timeline (task 0350) — the S6 analogue of `s3a-scenario.ts`, reused by the
 * scenario / e2e tiers so every tier drives the *same* deterministic `sl_tp_deadline_post_funding_event`
 * path (`07_strategy_6.md` §2/§3).
 *
 * S6 is signed-any and directional, so unlike S1/S3a it selects on **positive** funding: threshold
 * +0.3, BTC's scripted +0.35 selects (within the finder's ±0.1 proximity band), ETH's +0.01 does not.
 * `mainSide = long`, so the managed net position is LONG and the reduce-only OCO closes SHORT.
 *
 * The path: at entry a tiny PRE_FUNDING SELL MARKET (min feasible qty 0.001) opens a short — the
 * private-WS subscription. At settlement the WS `funding_fee` opens the gate, which fires the MAIN
 * BUY MARKET (0.01) reversing to a net LONG 0.009 at ~60 000. On the MAIN fill a static reduce-only
 * OCO rests — a SELL LIMIT TP at `60 000 × (1 + |0.2| × 1.5/100) = 60 180` and a SELL STOP-MARKET SL
 * at `60 000 × (1 − |0.2| × 1.5/100) = 59 820` (`|F|` = the **settled** +0.2, not the predicted +0.35)
 * — bounded by a deadline market close at `T_settle + 900 s`.
 */

import type { OrderAck, OrderRequest } from '../../src/core/ports/exchange-adapter.js'
import type { RuntimeStrategyConfig } from '../../src/core/strategies/registry.js'
import { createRiskGate } from '../../src/risk/gate.js'
import { buildSkeletonEngine, type SkeletonHarness } from './build-skeleton-engine.js'

const HOUR_MS = 3_600_000

export const START_MS = 7 * HOUR_MS
export const SCAN_TS = START_MS + 58 * 60_000
export const SETTLE_TS = 8 * HOUR_MS
export const ENTRY_OFFSET_SECONDS = 90
export const ENTRY_TS = SETTLE_TS - ENTRY_OFFSET_SECONDS * 1_000

/** BTC selects for S6's positive threshold; ETH's +0.01 is outside the ±0.1 proximity band. */
export const BTC = { symbol: 'BTC', price: 60_000, predicted: 0.35 } as const
export const ETH = { symbol: 'ETH', price: 3_000, predicted: 0.01 } as const

export const THRESHOLD_PERCENT = 0.3
/** Settled funding rate booked at settlement — deliberately ≠ the predicted 0.35 so the settled-|F| geometry is observable. */
export const SETTLE_RATE = 0.2
export const TP_MULTIPLIER = 1.5
export const SL_MULTIPLIER = 1.5
export const DEADLINE_SECONDS = 900
export const FUNDING_FEE_TIMEOUT_SECONDS = 10

/** MAIN fill ≈ mark 60 000; TP above, SL below (LONG net), both from the settled |F| = 0.2. */
export const MAIN_FILL_PX = 60_000
export const TP_LIMIT = MAIN_FILL_PX * (1 + (SETTLE_RATE * TP_MULTIPLIER) / 100) // 60 180
export const SL_TRIGGER = MAIN_FILL_PX * (1 - (SETTLE_RATE * SL_MULTIPLIER) / 100) // 59 820
export const DEADLINE_TS = SETTLE_TS + DEADLINE_SECONDS * 1_000
export const GATE_TIMEOUT_TS = SETTLE_TS + FUNDING_FEE_TIMEOUT_SECONDS * 1_000

/** Net managed qty = mainQty (0.01) − preQty (0.001); the reduce-only exit cap. */
export const NET_QTY = 0.009

export const INTENT_ID = `${BTC.symbol}-${ENTRY_TS}`

/** S6 runtime config for the shared scenario: LONG main, positive threshold, min-feasible PRE + 0.01 MAIN. */
export const S6_RUNTIME_CONFIG: RuntimeStrategyConfig = {
  id: 's6',
  thresholdPercent: THRESHOLD_PERCENT,
  direction: 'positive',
  entrySide: 'long',
  entryOffsetSeconds: ENTRY_OFFSET_SECONDS,
  fundingFeeTimeoutSeconds: FUNDING_FEE_TIMEOUT_SECONDS,
  tpMultiplier: TP_MULTIPLIER,
  slMultiplier: SL_MULTIPLIER,
  deadlineSeconds: DEADLINE_SECONDS,
  amountUsd: 600, // → mainQty 0.01 at 60 000
  leverage: 1,
}

/** Build a full S6 harness against fresh tmp files (the risk gate is widened for the 540-USD net notional). */
export function buildS6Engine(opts: { walPath: string; tracePath?: string; startMs?: number }): SkeletonHarness {
  return buildSkeletonEngine({
    ...opts,
    strategyConfig: S6_RUNTIME_CONFIG,
    riskGate: createRiskGate({ maxConcurrentIntents: 10, maxNotionalUsd: 10_000 }),
  })
}

/** Wrap `placeOrder` to record each order + the clock instant it was placed at. */
export function withPlacements(h: SkeletonHarness): Array<{ req: OrderRequest; ts: number }> {
  const placements: Array<{ req: OrderRequest; ts: number }> = []
  const rawPlace = h.exchange.placeOrder.bind(h.exchange)
  h.exchange.placeOrder = (req: OrderRequest): Promise<OrderAck> => {
    placements.push({ req, ts: h.clock.now() })
    return rawPlace(req)
  }
  return placements
}

/** Flush queued microtasks so the async REST net-confirm / abort ladder `.then`s resolve after a clock advance. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/**
 * Advance the virtual clock in 1 s steps, flushing microtasks so the gate + abort ladder progress
 * (their backoffs are clock timers). Used by the timeout / abort paths.
 */
export async function drain(h: SkeletonHarness, untilMs: number): Promise<void> {
  while (h.clock.now() < untilMs) {
    await flush()
    h.clock.advanceBy(1_000)
  }
  await flush()
}

/**
 * Scan → entry: PRE_FUNDING SELL MARKET fills (opens the tiny short), gate armed. On return the
 * intent is in SUBMITTING_ENTRY awaiting the funding event.
 */
export function driveToEntry(h: SkeletonHarness): void {
  const { clock, exchange, scheduler } = h
  exchange.setPrice(BTC.symbol, BTC.price)
  exchange.setPrice(ETH.symbol, ETH.price)
  exchange.setPredictedFunding(BTC.symbol, BTC.predicted, SCAN_TS)
  exchange.setPredictedFunding(ETH.symbol, ETH.predicted, SCAN_TS)
  scheduler.start()
  clock.advanceTo(SCAN_TS) // scan → schedules the BTC entry timer
  clock.advanceTo(ENTRY_TS) // entry → PRE_FUNDING placed + filled, gate armed
}

/**
 * Drive to MONITORING: entry, then advance to `T_settle` and settle funding — the WS `funding_fee`
 * opens the gate → MAIN fires + fills (reversal to net LONG) → REST net confirm → OCO rests. The
 * REST confirm is async, so `await`s the microtask flush.
 */
export async function driveToMonitoring(h: SkeletonHarness): Promise<void> {
  driveToEntry(h)
  h.clock.advanceTo(SETTLE_TS)
  h.exchange.settleFunding(BTC.symbol, SETTLE_RATE, SETTLE_TS) // FundingSettled(0.2) + FundingFeeAccrued → gate opens
  await flush() // let the async getPositions net-confirm resolve → enterMonitoring + OCO
}

/** Happy `tp_hit`: drive to MONITORING, then raise the mark past the TP limit → SELL LIMIT fills. */
export async function driveToTpExit(h: SkeletonHarness): Promise<void> {
  await driveToMonitoring(h)
  h.clock.advanceTo(SETTLE_TS + 1_000)
  // Rise clearly past the tick-rounded TP (60 180) so the reduce-only SELL LIMIT crosses → tp_hit.
  h.exchange.setPrice(BTC.symbol, TP_LIMIT + 20)
}

/**
 * The `funding_event_timeout` path: entry, then NO settlement — the gate times out at
 * `T_settle + timeout`, the abort ladder flattens the PRE leg, and the intent terminates NO_POSITION.
 */
export async function driveToTimeout(h: SkeletonHarness): Promise<void> {
  driveToEntry(h)
  await drain(h, GATE_TIMEOUT_TS + 6_000) // past the timeout + the abort-ladder backoffs
}
