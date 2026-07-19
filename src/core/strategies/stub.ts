/**
 * Stub strategy for the walking skeleton (task 0090) — **not** the real S1.
 *
 * A deliberately trivial stand-in that exercises the runtime end-to-end without
 * any real selection/sizing math: a single most-negative-funding threshold to
 * pick a symbol, a fixed base-unit quantity (no `amountUsd`→qty sizing — that is
 * 0120), long-only entry, and a `timed` hold-then-exit. It is replaced wholesale
 * by the spec-faithful S1 module in task 0280; nothing here encodes S1 semantics.
 *
 * Units (`00_globals.md` §1.2): `negativeFundingThresholdPercent` is **signed
 * percent** (`-0.3` = −0.30%); `entryOffsetMs`/`holdMs` are epoch-ms durations;
 * `entryQty` is **base units** (no precision rounding yet — 0120).
 */

import type { StrategyId } from './types.js'

export interface StubStrategyConfig {
  /** Placeholder id; the real strategy registry lands with S1 (0280). */
  readonly id: StrategyId
  /** Signed-negative selection threshold: select `symbol` when `rate ≤ threshold`. */
  readonly negativeFundingThresholdPercent: number
  /** Delay from the `HH:58` scan to the entry timer, epoch-ms duration. */
  readonly entryOffsetMs: number
  /** Hold duration from fill to the `timed` deadline exit, epoch-ms duration. */
  readonly holdMs: number
  /** Fixed order quantity, base units (bypasses 0120 sizing). */
  readonly entryQty: number
}

export interface StubStrategy {
  readonly config: StubStrategyConfig
  /** Whether a predicted funding `rate` (signed percent) clears the selection threshold. */
  selects(rate: number): boolean
}

export function createStubStrategy(config: StubStrategyConfig): StubStrategy {
  return {
    config,
    selects(rate: number): boolean {
      // Most-negative-funding rule: a rate at or below the (negative) threshold
      // is a candidate. `-0.5 ≤ -0.3` selects; `+0.01 ≤ -0.3` does not.
      return rate <= config.negativeFundingThresholdPercent
    },
  }
}
