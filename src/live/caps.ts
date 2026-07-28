/**
 * Compiled-in live-tier money ceilings (task 0470).
 *
 * These are **constants, not config**: a live run trades real money on a real venue, so
 * the ceiling must not be reachable from a YAML file, an env var, or a CLI flag. The only
 * knob is {@link resolveCaps}, and it clamps **down** — a caller may run a tighter suite,
 * never a looser one.
 *
 * Same number on every venue. Reduce-only orders are exempt (a close must always be able
 * to exceed the cap, or the harness could not flatten what it opened) — that exemption
 * lives in `notional-cap.ts`, not here.
 */

/** Ceiling on a single non-reduce-only order's notional, USD. */
export const LIVE_MAX_ORDER_NOTIONAL_USD = 25

/** Ceiling on the running sum of non-reduce-only notional placed by one run, USD. */
export const LIVE_MAX_TOTAL_NOTIONAL_USD = 50

/** The live-tier suites (task 0470 phases 4/6/7). */
export const LIVE_SUITES = ['self-test', 'fill-test', 'funding-test'] as const
export type LiveSuite = (typeof LIVE_SUITES)[number]

/**
 * Per-suite realized-fee budget, USD — the verdict fails the run when actual fees exceed
 * it. Sized from "taker fee on one capped order, both legs, worst venue fee tier", plus
 * headroom: `self-test` places no filling order at all, `fill-test` pays one round trip,
 * `funding-test` pays a round trip plus a settlement.
 */
export const LIVE_SUITE_FEE_BOUND_USD: Readonly<Record<LiveSuite, number>> = {
  'self-test': 0.02,
  'fill-test': 0.06,
  'funding-test': 0.12,
}

export interface LiveCaps {
  /** Ceiling on one non-reduce-only order's notional, USD. */
  readonly maxOrderNotionalUsd: number
  /** Ceiling on the run's cumulative non-reduce-only notional, USD. */
  readonly maxTotalNotionalUsd: number
}

/** A caller may only tighten the compiled-in ceilings. */
export type LiveCapsOverride = Partial<LiveCaps>

/** Reject a ceiling that is not a usable positive, finite number. */
function checkPositive(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`[live] ${field} must be a finite number > 0, got ${value}`)
  }
}

/**
 * The effective caps for a run. An override clamps **down only** (`Math.min` against the
 * compiled-in constant), so no caller — CLI flag, suite, or future config — can widen the
 * ceiling. `0`, a negative, `NaN`, and `Infinity` throw rather than silently disarming it.
 */
export function resolveCaps(override: LiveCapsOverride = {}): LiveCaps {
  if (override.maxOrderNotionalUsd !== undefined) {
    checkPositive('maxOrderNotionalUsd', override.maxOrderNotionalUsd)
  }
  if (override.maxTotalNotionalUsd !== undefined) {
    checkPositive('maxTotalNotionalUsd', override.maxTotalNotionalUsd)
  }
  return {
    maxOrderNotionalUsd: Math.min(
      LIVE_MAX_ORDER_NOTIONAL_USD,
      override.maxOrderNotionalUsd ?? Number.POSITIVE_INFINITY,
    ),
    maxTotalNotionalUsd: Math.min(
      LIVE_MAX_TOTAL_NOTIONAL_USD,
      override.maxTotalNotionalUsd ?? Number.POSITIVE_INFINITY,
    ),
  }
}
