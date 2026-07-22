/**
 * Shared S4.2a composition + timeline (task 0340) — the single-limit analogue of `s4-1a-scenario.ts`,
 * reused by the scenario, golden, and e2e tiers so every tier drives the same deterministic path
 * (`06_strategy_4_2a.md` §2/§3).
 *
 * S4.2a selects identically to S1/S2/S3a/S4.1a (shared §G-L/§G-R helper), so it reuses the skeleton
 * timeline constants (`SCAN_TS`/`SETTLE_TS`/`ENTRY_TS`/`INTENT_ID`, BTC triggers, ETH does not) and
 * `driveToEntry`. `buildSkeletonEngine` auto-selects the S4.2a module + ladder `sl_tp_deadline`
 * handler from the `s4-2a` strategy id. LONG is the default side (no `entrySide`).
 *
 * The path: at entry (`T_settle − 90 s`, price still 60 000) ONE BUY-LIMIT rests at `P_limit =
 * 60 000 × (1 − 0.35 × 0.75/100)`, carrying `expireAt = T_settle + deadlineSeconds`; an engine-side
 * conditional SL is armed at `P_limit × (1 − 0.35 × 1.5/100)`. A post-settlement dip to `P_limit`
 * fills it; the fill places a reduce-only SELL-LIMIT TP at `P_fill × (1 + 0.2/100)`. Exit is the
 * first of TP / engine-SL / deadline; a limit that never fills expires → `NO_POSITION{limit_expired}`.
 *
 * Sizing: `amountUsd 300` splits to a single 0.005-BTC lot at `P_limit`; the harness risk gate is
 * widened to `maxNotionalUsd 1000` so the 300-USD limit clears preflight.
 */

import type { RuntimeStrategyConfig } from '../../src/core/strategies/registry.js'
import { createRiskGate } from '../../src/risk/gate.js'
import { buildSkeletonEngine, DEFAULT_RUNTIME_CONFIG, type SkeletonHarness } from './build-skeleton-engine.js'
import { BTC, driveToEntry, SETTLE_TS } from './skeleton-scenario.js'

export const LIMIT_OFFSET_MULT = 0.75
export const TAKE_PROFIT_PCT = 0.2
export const SL_MULTIPLIER = 1.5
export const DEADLINE_SECONDS = 900
export const LIMIT_AMOUNT_USD = 300

/** The tick-snapped single BUY-LIMIT price for the shared timeline (`P_ref 60 000`, `|F| 0.35`). */
export const LIMIT_PRICE = 59842.5
/** One 0.005-BTC lot (`amountUsd 300 / P_limit`, lot-floored). */
export const TOTAL_QTY = 0.005
/** Engine-side SL trigger: `P_limit × (1 − 0.35 × 1.5/100)` (raw, not tick-snapped). */
export const SL_TRIGGER = LIMIT_PRICE * (1 - (0.35 * SL_MULTIPLIER) / 100) // ≈ 59528.33
/** TP limit on the fill: `P_limit × (1 + 0.2/100)`, tick-snapped. */
export const TP_PRICE = 59962.2
/** The deadline / limit-expiry instant: `T_settle + deadlineSeconds` (`06` §2). */
export const DEADLINE_TS = SETTLE_TS + DEADLINE_SECONDS * 1_000
/** Settlement funding rate booked in the scenario (long receives `+|F|` when a position is open). */
export const SETTLE_RATE = -0.35

/** S4.2a runtime config for the shared scenario: skeleton selection + LONG single-limit exit params. */
export const S4_2A_RUNTIME_CONFIG: RuntimeStrategyConfig = {
  id: 's4-2a',
  thresholdPercent: DEFAULT_RUNTIME_CONFIG.thresholdPercent,
  direction: 'negative',
  entryOffsetSeconds: DEFAULT_RUNTIME_CONFIG.entryOffsetSeconds,
  limitOffsetMult: LIMIT_OFFSET_MULT,
  takeProfitPct: TAKE_PROFIT_PCT,
  slMultiplier: SL_MULTIPLIER,
  deadlineSeconds: DEADLINE_SECONDS,
  amountUsd: LIMIT_AMOUNT_USD,
  leverage: 1,
}

/** Build a full S4.2a harness against fresh tmp files, with a risk gate wide enough for the 300-USD limit. */
export function buildS4_2aEngine(opts: {
  walPath: string
  tracePath?: string
  startMs?: number
  onOpsEvent?: (event: { kind: string; intentId: string; symbol: string }) => void
}): SkeletonHarness {
  return buildSkeletonEngine({
    ...opts,
    strategyConfig: S4_2A_RUNTIME_CONFIG,
    riskGate: createRiskGate({ maxConcurrentIntents: 10, maxNotionalUsd: 1_000 }),
  })
}

/** Drive to the single limit resting SUBMITTING_ENTRY: scan → entry (one rung rests, SL armed). Clock at `ENTRY_TS`. */
export function driveToLimitResting(h: SkeletonHarness): void {
  driveToEntry(h)
}

/**
 * Drive past settlement with the limit still resting (no fill pre-settlement): scan → entry →
 * advance to `T_settle` and settle funding (no position ⇒ no accrual). Clock at `T_settle`.
 */
export function driveToSettledNoFill(h: SkeletonHarness): void {
  driveToLimitResting(h)
  h.clock.advanceTo(SETTLE_TS)
  h.exchange.settleFunding(BTC.symbol, SETTLE_RATE, SETTLE_TS)
}

/**
 * The no-fill → `limit_expired` path (synchronous, replayable) — the golden/e2e path. Drive past
 * settlement, then advance to the deadline with the limit never crossed: the venue expires it and
 * the intent terminates `NO_POSITION{limit_expired}` with no position, no fees, the SL disarmed.
 */
export function driveToLimitExpired(h: SkeletonHarness): void {
  driveToSettledNoFill(h)
  h.clock.advanceTo(DEADLINE_TS) // price never dipped to P_limit → the limit expires
}
