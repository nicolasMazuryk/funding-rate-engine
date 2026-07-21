/**
 * Shared S2 composition + timeline (task 0310) — the S2 analogue of `s1-ws-scenario.ts`,
 * reused by the scenario, golden, and e2e tiers so every tier drives the *same*
 * deterministic trailing-retracement path.
 *
 * S2 selects identically to S1/S1-WS (shared §G-L helper), so it reuses the skeleton
 * timeline constants (`SCAN_TS`/`SETTLE_TS`/`ENTRY_TS`/`INTENT_ID`, BTC triggers / ETH does
 * not) and `driveToEntry`. `buildSkeletonEngine` auto-selects the retracement handler + its
 * funding gate from the `s2` strategy id (see `build-skeleton-harness.ts`).
 *
 * The path: entry fills at 60 000 → SL rests at `60 000 × (1 − |−0.3| × 2 / 100) = 59 640`;
 * a WS funding-fee at `T_settle` opens the gate and arms the tracker; then the price prints
 * lows (each rotating the TP, which sits at the anchor with `retracementPct = 1`) and finally
 * recovers to 60 000 so the TP limit fills → `tp_hit`.
 */

import type { OrderAck, OrderRequest } from '../../src/core/ports/exchange-adapter.js'
import type { RuntimeStrategyConfig } from '../../src/core/strategies/registry.js'
import { buildSkeletonEngine, DEFAULT_RUNTIME_CONFIG, type SkeletonHarness } from './build-skeleton-engine.js'
import { BTC, driveToEntry, SETTLE_TS } from './skeleton-scenario.js'

/** Gate timeout past `T_settle`, seconds — the tracker-arming fallback if no accrual lands (`03` §2 step 3). */
export const FUNDING_FEE_TIMEOUT_SECONDS = 10
/** Deadline past `T_settle`, seconds — the no-recovery bound (`03` §3). */
export const DEADLINE_SECONDS = 900
/** SL distance multiplier on `|F|` (`03` §5). */
export const SL_MULTIPLIER = 2.0
/** Trailing TP retracement fraction — 1.0 ⇒ TP sits at the anchor (`03` §5, carried from live). */
export const RETRACEMENT_PCT = 1.0
/** WS funding-fee `T_drop` offset used by the happy path: 4 s after `T_settle`, inside ±5 s. */
export const WS_FUNDING_OFFSET_MS = 4_000

/** SL trigger for the shared timeline: `60 000 × (1 − 0.3 × 2 / 100)`. */
export const SL_TRIGGER = 59_640
/** The deadline instant: `T_settle + deadlineSeconds` (`03` §3). */
export const DEADLINE_TS = SETTLE_TS + DEADLINE_SECONDS * 1_000

/**
 * S2 runtime config for the shared scenario — S1's skeleton values (threshold −0.3, entry
 * offset 90 s, `amountUsd 60`/`leverage 1` → BTC qty 0.001) plus S2's exit params.
 */
export const S2_RUNTIME_CONFIG: RuntimeStrategyConfig = {
  id: 's2',
  thresholdPercent: DEFAULT_RUNTIME_CONFIG.thresholdPercent,
  direction: 'negative',
  entryOffsetSeconds: DEFAULT_RUNTIME_CONFIG.entryOffsetSeconds,
  fundingFeeTimeoutSeconds: FUNDING_FEE_TIMEOUT_SECONDS,
  retracementPct: RETRACEMENT_PCT,
  slMultiplier: SL_MULTIPLIER,
  deadlineSeconds: DEADLINE_SECONDS,
  amountUsd: DEFAULT_RUNTIME_CONFIG.amountUsd,
  leverage: DEFAULT_RUNTIME_CONFIG.leverage,
}

/** Build a full S2 harness against fresh tmp files (scenario + golden tiers). */
export function buildS2Engine(opts: { walPath: string; tracePath?: string; startMs?: number }): SkeletonHarness {
  return buildSkeletonEngine({ ...opts, strategyConfig: S2_RUNTIME_CONFIG })
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

/**
 * Drive to a **trailing** tracker: scan → entry → MONITORING (SL resting), then a WS
 * `funding_fee` at `T_settle` opens the gate and arms the tracker. On return the clock is at
 * `T_settle`, funding is booked, and the next `setPrice` low will rotate the TP.
 */
export function driveToTrailing(h: SkeletonHarness): void {
  driveToEntry(h)
  h.clock.advanceTo(SETTLE_TS)
  // Funding accrues against the open long; `T_drop` inside ±5 s opens the gate (WS path).
  h.exchange.settleFunding(BTC.symbol, -0.4, SETTLE_TS + WS_FUNDING_OFFSET_MS)
}

/**
 * The tp_hit happy path (synchronous, replayable): drive to trailing, print two descending
 * lows (rotating the TP at the anchor), then recover to 60 000 so the TP limit fills → `tp_hit`.
 */
export function driveToTpExit(h: SkeletonHarness): void {
  driveToTrailing(h)
  h.clock.advanceTo(SETTLE_TS + 1_000)
  h.exchange.setPrice(BTC.symbol, 59_800) // first trailing low → place TP at the anchor (60 000)
  h.clock.advanceTo(SETTLE_TS + 2_000)
  h.exchange.setPrice(BTC.symbol, 59_700) // lower low → cancel + re-place TP
  h.clock.advanceTo(SETTLE_TS + 3_000)
  h.exchange.setPrice(BTC.symbol, 60_000) // recovery to the anchor → TP limit fills → tp_hit
}
