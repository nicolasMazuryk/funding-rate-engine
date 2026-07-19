/**
 * Stub strategy for the walking skeleton (task 0090/0130) — **not** the real S1.
 *
 * A deliberately trivial `StrategyModule`: it registers under an id and applies a
 * single most-negative-funding threshold to a guarded candidate. It exercises the
 * registry dispatch + selection path end-to-end without any real selection/sizing
 * math (long-only, fixed base-unit qty, `timed` hold-then-exit). It is replaced
 * wholesale by the spec-faithful S1 module in task 0280.
 *
 * Units (`00_globals.md` §1.2): `negativeFundingThresholdPercent` is **signed
 * percent** (`-0.3` = −0.30%); `entryOffsetSeconds` is a seconds duration; `holdMs`
 * is an epoch-ms duration; `entryQty` is **base units** (no precision rounding — 0120).
 */

import type { StrategyModule } from './registry.js'
import type { StrategyId } from './types.js'

export interface StubStrategyConfig {
  /** Placeholder id the stub registers under. */
  readonly id: StrategyId
  /** Signed-negative selection threshold: select `symbol` when `rate ≤ threshold`. */
  readonly negativeFundingThresholdPercent: number
  /** Delay from `T_settle` to the entry timer, seconds (aligns with `entry_offset_seconds`). */
  readonly entryOffsetSeconds: number
  /** Hold duration from fill to the `timed` deadline exit, epoch-ms duration. */
  readonly holdMs: number
  /** Fixed order quantity, base units (bypasses 0120 sizing). */
  readonly entryQty: number
}

/**
 * Build the stub as a `StrategyModule`. Selection reads the threshold from the
 * runtime config passed at scan time (not the build-time config), so the engine
 * owns the effective threshold; the module only encodes the direction rule.
 */
export function createStubStrategy(config: StubStrategyConfig): StrategyModule {
  return {
    id: config.id,
    exitPolicyKind: 'timed',
    select(candidate, runtime) {
      // Most-negative-funding rule: a rate at or below the (negative) threshold
      // is selected. `-0.5 ≤ -0.3` selects; `-0.29 ≤ -0.3` does not.
      return candidate.ratePercent <= runtime.thresholdPercent
        ? { symbol: candidate.symbol, settleTs: candidate.settleTs }
        : undefined
    },
  }
}
