/**
 * Shared S3a composition + timeline (task 0320) — the S3a analogue of `s2-scenario.ts`, reused
 * by the scenario, golden, and e2e tiers so every tier drives the *same* deterministic
 * `sl_tp_deadline` path (`04_strategy_3a.md` §2/§3).
 *
 * S3a selects identically to S1/S2 (shared §G-L helper), so it reuses the skeleton timeline
 * constants (`SCAN_TS`/`SETTLE_TS`/`ENTRY_TS`/`INTENT_ID`, BTC triggers / ETH does not) and
 * `driveToEntry`. `buildSkeletonEngine` auto-selects the `sl_tp_deadline` handler from the `s3a`
 * strategy id (see `build-skeleton-harness.ts`). SHORT is expressed via `entrySide: 'short'`.
 *
 * The path: a SELL MARKET entry fills at 60 000, opening a short. On fill a static reduce-only
 * OCO pair rests — a BUY STOP-MARKET SL at `60 000 × (1 + 1.0/100) = 60 600` and a BUY LIMIT TP
 * at `60 000 × (1 − |−0.35| × 1.5/100) = 59 685` (`|F|` is the realized predicted rate the intent
 * entered on) — plus a deadline market close at `T_settle + 900 s`.
 */

import type { OrderAck, OrderRequest } from '../../src/core/ports/exchange-adapter.js'
import type { RuntimeStrategyConfig } from '../../src/core/strategies/registry.js'
import { buildSkeletonEngine, DEFAULT_RUNTIME_CONFIG, type SkeletonHarness } from './build-skeleton-engine.js'
import { BTC, driveToEntry, SETTLE_TS } from './skeleton-scenario.js'

/** Fixed SL distance, percent — NOT a multiple of `|F|` (`04` §5). */
export const STOP_LOSS_PERCENT = 1.0
/** TP distance multiplier on `|F|` (`04` §3/§5). */
export const TP_VARIANT_A_MULTIPLIER = 1.5
/** Deadline past `T_settle`, seconds (`04` §5). */
export const DEADLINE_SECONDS = 900

/** SL trigger for the shared timeline: `60 000 × (1 + 1.0/100)`. */
export const SL_TRIGGER = 60_600
/** TP limit for the shared timeline: `60 000 × (1 − |−0.35| × 1.5/100)` — `|F|` = BTC's predicted −0.35. */
export const TP_LIMIT = 59_685
/** The deadline instant: `T_settle + deadlineSeconds` (`04` §3). */
export const DEADLINE_TS = SETTLE_TS + DEADLINE_SECONDS * 1_000
/** Settlement funding rate booked in the scenario (short pays `−|F|`); the exact value is irrelevant to the exit. */
export const SETTLE_RATE = -0.35

/**
 * S3a runtime config for the shared scenario — S1's skeleton values (threshold −0.3, entry offset
 * 90 s, `amountUsd 60`/`leverage 1` → BTC qty 0.001) plus S3a's SHORT side + OCO exit params.
 */
export const S3A_RUNTIME_CONFIG: RuntimeStrategyConfig = {
  id: 's3a',
  thresholdPercent: DEFAULT_RUNTIME_CONFIG.thresholdPercent,
  direction: 'negative',
  entrySide: 'short',
  entryOffsetSeconds: DEFAULT_RUNTIME_CONFIG.entryOffsetSeconds,
  stopLossPercent: STOP_LOSS_PERCENT,
  tpVariantAMultiplier: TP_VARIANT_A_MULTIPLIER,
  deadlineSeconds: DEADLINE_SECONDS,
  amountUsd: DEFAULT_RUNTIME_CONFIG.amountUsd,
  leverage: DEFAULT_RUNTIME_CONFIG.leverage,
}

/** Build a full S3a harness against fresh tmp files (scenario + golden tiers). */
export function buildS3aEngine(opts: { walPath: string; tracePath?: string; startMs?: number }): SkeletonHarness {
  return buildSkeletonEngine({ ...opts, strategyConfig: S3A_RUNTIME_CONFIG })
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
 * Drive to MONITORING with the OCO pair resting, past settlement with funding booked: scan →
 * entry (short fills at 60 000, SL + TP rest) → advance to `T_settle` and settle funding (short
 * pays, so the accrual verdict is booked while open). On return the clock is at `T_settle`.
 */
export function driveToSettled(h: SkeletonHarness): void {
  driveToEntry(h)
  h.clock.advanceTo(SETTLE_TS)
  h.exchange.settleFunding(BTC.symbol, SETTLE_RATE, SETTLE_TS)
}

/**
 * The tp_hit happy path (synchronous, replayable): drive past settlement, then drop the mark to
 * the TP limit so the resting BUY LIMIT fills → `tp_hit`, sibling SL swept.
 */
export function driveToTpExit(h: SkeletonHarness): void {
  driveToSettled(h)
  h.clock.advanceTo(SETTLE_TS + 1_000)
  h.exchange.setPrice(BTC.symbol, TP_LIMIT) // drop to the TP → BUY LIMIT fills → tp_hit
}

/**
 * The sl_hit path with a gap-through: drive past settlement, then spike the mark *above* the SL
 * trigger so the BUY STOP-MARKET fills at the (worse) mark, not the trigger (`04` §3).
 */
export function driveToSlExit(h: SkeletonHarness, spikePx = 60_700): void {
  driveToSettled(h)
  h.clock.advanceTo(SETTLE_TS + 1_000)
  h.exchange.setPrice(BTC.symbol, spikePx) // gap through the SL trigger → stop fills at the mark
}

/**
 * The deadline path (chop, no fill): drive past settlement, print a mark strictly between the TP
 * and the SL so neither leg fills, then advance to the deadline → market close.
 */
export function driveToDeadlineExit(h: SkeletonHarness): void {
  driveToSettled(h)
  h.clock.advanceTo(SETTLE_TS + 1_000)
  h.exchange.setPrice(BTC.symbol, 60_100) // between TP (59 685) and SL (60 600): nothing fills
  h.clock.advanceTo(DEADLINE_TS) // deadline → BUY MARKET reduce-only close
}
