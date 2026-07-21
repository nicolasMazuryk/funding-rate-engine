/**
 * Shared S1-WS composition + timeline (task 0300) — the S1-WS analogue of
 * `skeleton-scenario.ts`, reused by the scenario, golden, and e2e tiers so every tier
 * drives the *same* deterministic funding-fee-event path.
 *
 * S1-WS selects identically to S1 (shared §G-L helper), so it reuses the skeleton
 * timeline constants (`SCAN_TS`/`SETTLE_TS`/`ENTRY_TS`/`INTENT_ID`, BTC triggers / ETH
 * does not) and `driveToEntry`. The only difference is the exit: `buildSkeletonEngine`
 * auto-selects the `funding_fee_event` handler + its funding gate from the `s1-ws`
 * strategy id (see `build-skeleton-harness.ts`), so a harness is just the skeleton engine
 * built with {@link S1_WS_RUNTIME_CONFIG}.
 */

import type { RuntimeStrategyConfig } from '../../src/core/strategies/registry.js'
import { buildSkeletonEngine, DEFAULT_RUNTIME_CONFIG, type SkeletonHarness } from './build-skeleton-engine.js'
import { BTC, driveToEntry, SETTLE_TS } from './skeleton-scenario.js'

/** Gate timeout past `T_settle`, seconds — the fallback exit fires here if no accrual lands. */
export const FUNDING_FEE_TIMEOUT_SECONDS = 10
/** WS funding-fee `T_drop` offset used by the happy path: 4 s after `T_settle`, inside ±5 s. */
export const WS_FUNDING_OFFSET_MS = 4_000
/** The gate-timeout instant: `T_settle + fundingFeeTimeoutSeconds` (`02` §2). */
export const GATE_TIMEOUT_TS = SETTLE_TS + FUNDING_FEE_TIMEOUT_SECONDS * 1_000
/** REST safety-net poll instant: `T_settle + 3 s` (`00_globals.md` §6). */
export const REST_POLL_TS = SETTLE_TS + 3_000

/**
 * S1-WS runtime config for the shared scenario — S1's skeleton values with the `timed`
 * `exitOffsetSeconds` swapped for the gate's `fundingFeeTimeoutSeconds`. `entryOffsetSeconds`
 * matches the skeleton (90 s) so `ENTRY_TS`/`INTENT_ID` are reused unchanged.
 */
export const S1_WS_RUNTIME_CONFIG: RuntimeStrategyConfig = {
  id: 's1-ws',
  thresholdPercent: DEFAULT_RUNTIME_CONFIG.thresholdPercent,
  direction: 'negative',
  entryOffsetSeconds: DEFAULT_RUNTIME_CONFIG.entryOffsetSeconds,
  fundingFeeTimeoutSeconds: FUNDING_FEE_TIMEOUT_SECONDS,
  amountUsd: DEFAULT_RUNTIME_CONFIG.amountUsd,
  leverage: DEFAULT_RUNTIME_CONFIG.leverage,
}

/** Build a full S1-WS harness against fresh tmp files (scenario + golden tiers). */
export function buildS1WsEngine(opts: { walPath: string; tracePath?: string; startMs?: number }): SkeletonHarness {
  return buildSkeletonEngine({ ...opts, strategyConfig: S1_WS_RUNTIME_CONFIG })
}

/**
 * The WS-event happy path (synchronous, replayable): scan → entry → MONITORING, then a WS
 * `funding_fee` within ±5 s of `T_settle` opens the gate → the reduce-only exit fires
 * synchronously → CLOSED{funding_fee_event}. No async poll on this path (the clock stays
 * at `T_settle`, before the `T_settle+3 s` REST poll fires).
 */
export function driveToWsFundingExit(h: SkeletonHarness): void {
  driveToEntry(h)
  h.clock.advanceTo(SETTLE_TS)
  // WS funding-fee accrues against the open long; `T_drop` 4 s after `T_settle` (inside ±5 s).
  h.exchange.settleFunding(BTC.symbol, -0.4, SETTLE_TS + WS_FUNDING_OFFSET_MS)
}
