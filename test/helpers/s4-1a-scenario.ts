/**
 * Shared S4.1a composition + timeline (task 0330) — the ladder analogue of `s3a-scenario.ts`,
 * reused by the scenario, golden, and e2e tiers so every tier drives the same deterministic ladder
 * path (`05_strategy_4_1a.md` §2/§3).
 *
 * S4.1a selects identically to S1/S2/S3a (shared §G-L/§G-R helper), so it reuses the skeleton
 * timeline constants (`SCAN_TS`/`SETTLE_TS`/`ENTRY_TS`/`INTENT_ID`, BTC triggers, ETH does not) and
 * `driveToEntry`. `buildSkeletonEngine` auto-selects the ladder `sl_tp_deadline` handler from the
 * `s4-1a` strategy id. LONG is the default side (no `entrySide`).
 *
 * The path: at entry (`T_settle − 90 s`, price still 60 000) five BUY-LIMIT rungs rest below
 * 60 000, and an engine-side conditional SL is armed at `P_avg_full × (1 − 0.35 × 2.5/100)`. The
 * post-settlement drop fills rungs; each fill (re-)places a reduce-only SELL-LIMIT TP at
 * `P_avg × (1 + 0.3/100)`. Exit is the first of TP / engine-SL / deadline (`T_settle + 900 s`).
 *
 * Sizing: `amountUsd 300` splits to exactly one lot (0.001 BTC) per rung at 60 000; the harness
 * risk gate is widened to `maxNotionalUsd 1000` so the 300-USD ladder clears preflight.
 */

import type { RuntimeStrategyConfig } from '../../src/core/strategies/registry.js'
import { createRiskGate } from '../../src/risk/gate.js'
import { buildSkeletonEngine, DEFAULT_RUNTIME_CONFIG, type SkeletonHarness } from './build-skeleton-engine.js'
import { BTC, driveToEntry, SETTLE_TS } from './skeleton-scenario.js'

export const LADDER_COUNT = 5
export const LADDER_TOP_MULT = 0.7
export const LADDER_BOTTOM_MULT = 1.8
export const TAKE_PROFIT_PCT = 0.3
export const SL_MULTIPLIER = 2.5
export const DEADLINE_SECONDS = 900
export const LADDER_AMOUNT_USD = 300

/** The tick-snapped rung BUY-LIMIT prices for the shared timeline (`P_ref 60 000`, `|F| 0.35`). */
export const LADDER_PRICES = [59853, 59795.3, 59737.5, 59679.8, 59622] as const
/** One lot (0.001 BTC) per rung; five rungs. */
export const RUNG_QTY = 0.001
export const TOTAL_QTY = 0.005
/** `P_avg_full` over all five placed rungs — the engine-side SL anchor. */
export const P_AVG_FULL = 59737.52
/** Engine-side SL trigger: `P_avg_full × (1 − 0.35 × 2.5/100)` (raw, not tick-snapped). */
export const SL_TRIGGER = P_AVG_FULL * (1 - (0.35 * SL_MULTIPLIER) / 100) // ≈ 59214.82
/** TP limit once all five rungs are filled: `P_avg_full × (1 + 0.3/100)`, tick-snapped. */
export const TP_ALL = 59916.7
/** The deadline instant: `T_settle + deadlineSeconds` (`05` §5). */
export const DEADLINE_TS = SETTLE_TS + DEADLINE_SECONDS * 1_000
/** Settlement funding rate booked in the scenario (long receives `+|F|` when a position is open). */
export const SETTLE_RATE = -0.35

/** S4.1a runtime config for the shared scenario: skeleton selection + LONG ladder exit params. */
export const S4_1A_RUNTIME_CONFIG: RuntimeStrategyConfig = {
  id: 's4-1a',
  thresholdPercent: DEFAULT_RUNTIME_CONFIG.thresholdPercent,
  direction: 'negative',
  entryOffsetSeconds: DEFAULT_RUNTIME_CONFIG.entryOffsetSeconds,
  ladderCount: LADDER_COUNT,
  ladderTopMult: LADDER_TOP_MULT,
  ladderBottomMult: LADDER_BOTTOM_MULT,
  takeProfitPct: TAKE_PROFIT_PCT,
  slMultiplier: SL_MULTIPLIER,
  deadlineSeconds: DEADLINE_SECONDS,
  amountUsd: LADDER_AMOUNT_USD,
  leverage: 1,
}

/** Build a full S4.1a harness against fresh tmp files, with a risk gate wide enough for the 300-USD ladder. */
export function buildS4_1aEngine(opts: {
  walPath: string
  tracePath?: string
  startMs?: number
  onOpsEvent?: (event: { kind: string; intentId: string; symbol: string }) => void
}): SkeletonHarness {
  return buildSkeletonEngine({
    ...opts,
    strategyConfig: S4_1A_RUNTIME_CONFIG,
    riskGate: createRiskGate({ maxConcurrentIntents: 10, maxNotionalUsd: 1_000 }),
  })
}

/** Drive to the ladder resting SUBMITTING_ENTRY: scan → entry (five rungs rest, SL armed). Clock at `ENTRY_TS`. */
export function driveToLadderResting(h: SkeletonHarness): void {
  driveToEntry(h)
}

/**
 * Drive past settlement with the ladder still resting (no rung filled pre-settlement): scan → entry
 * → advance to `T_settle` and settle funding (no position ⇒ no accrual). Clock at `T_settle`.
 */
export function driveToSettledNoFill(h: SkeletonHarness): void {
  driveToLadderResting(h)
  h.clock.advanceTo(SETTLE_TS)
  h.exchange.settleFunding(BTC.symbol, SETTLE_RATE, SETTLE_TS)
}

/**
 * The partial-fill → SL exit path (synchronous, replayable) — the golden/e2e path. Drive past
 * settlement, fill the top two rungs with a shallow dip, then drop below the engine-side SL trigger
 * so it fires and closes exactly the filled qty; the three unfilled rungs are cancelled.
 */
export function driveToPartialSlExit(h: SkeletonHarness): void {
  driveToSettledNoFill(h)
  h.clock.advanceTo(SETTLE_TS + 1_000)
  h.exchange.setPrice(BTC.symbol, 59_750) // fills the top two rungs → MONITORING, TP resting
  h.clock.advanceTo(SETTLE_TS + 2_000)
  h.exchange.setPrice(BTC.symbol, 59_200) // below the SL trigger → sl_hit, unfilled rungs cancelled
}
