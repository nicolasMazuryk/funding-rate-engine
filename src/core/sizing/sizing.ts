/**
 * Order sizing, tick/lot rounding and feasibility — pure core
 * (`00_globals.md` §4 sizing, §G-R ladder; `11_execution_and_account_state.md`
 * §3 feasibility table; `10` §4 precision/denomination).
 *
 * Every order flows through this math: a wrong `contractSize` or a float-drift
 * bug here silently mis-sizes every order (`10` §4), so the flooring is
 * epsilon-guarded and the ladder split is deterministic. No I/O — the file
 * depends only on the `Instrument` value type and plain arithmetic.
 */

import type { Instrument } from '../ports/exchange-adapter.js'

/** One ladder rung: a limit price and the base-unit qty resting at it (`00_globals.md` §G-R). */
export interface Rung {
  readonly price: number
  readonly qty: number
}

/** Feasibility verdict for a candidate order (`11` §3 table). */
export type Feasibility = { readonly ok: true } | { readonly ok: false; readonly reason: FeasibilityReason }

/** Why a candidate order is infeasible (`11` §3). */
export type FeasibilityReason = 'zero_qty' | 'min_notional' | 'min_qty'

/**
 * Relative slack that absorbs binary float drift when snapping a ratio to an
 * integer step count. A ratio landing within this band of an integer (e.g.
 * `29.999999999999996` for `0.030 / 0.001`) is treated as that integer, so
 * lot flooring of a value that is "really" a step multiple does not drop a
 * whole quantum. Far larger than double-precision noise, far smaller than one
 * lot step, so genuine sub-quantum amounts still floor down.
 */
const RATIO_EPSILON = 1e-9

/** Integer number of `step` quanta in `value`, snapping past float noise to the nearest integer. */
function stepCount(value: number, step: number): number {
  const ratio = value / step
  const nearest = Math.round(ratio)
  const tolerance = RATIO_EPSILON * Math.max(1, Math.abs(ratio))
  return Math.abs(nearest - ratio) <= tolerance ? nearest : Math.floor(ratio)
}

/** Floor `value` down to a multiple of `step` (lot step); float-noise safe. */
function floorToStep(value: number, step: number): number {
  return stepCount(value, step) * step
}

/** Round `value` to the nearest multiple of `step` (tick). */
function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step
}

/**
 * Base-unit qty for a fixed USD notional (`00_globals.md` §4):
 * `amountUsd / price / contractSize`, floored to the lot step (`amountPrecision`).
 */
export function computeQty(amountUsd: number, price: number, instrument: Instrument): number {
  const rawQty = amountUsd / price / instrument.contractSize
  return floorToStep(rawQty, instrument.amountPrecision)
}

/** Round a price to the venue tick (`pricePrecision`); never rejects (`11` §3 table). */
export function roundPrice(price: number, instrument: Instrument): number {
  return roundToStep(price, instrument.pricePrecision)
}

/**
 * Feasibility of a (lot-floored) order against the exchange minimums
 * (`11` §3 table, in spec order: lot-floor-to-zero, then min notional, then
 * min qty). A failing symbol is skipped, never coerced up.
 */
export function checkFeasibility(qty: number, price: number, instrument: Instrument): Feasibility {
  if (qty <= 0) return { ok: false, reason: 'zero_qty' }
  if (qty * price < instrument.minNotional) return { ok: false, reason: 'min_notional' }
  if (qty < instrument.minQty) return { ok: false, reason: 'min_qty' }
  return { ok: true }
}

/**
 * Cap a reduce-only exit qty to the tracked position qty (`11` §3 reduce-only
 * sanity row) — an exit never asks for more than is held.
 */
export function capReduceOnlyQty(requestedQty: number, positionQty: number): number {
  return Math.min(requestedQty, positionQty)
}

/**
 * Split a fixed USD notional across ladder rungs by largest-remainder over the
 * lot step (`00_globals.md` §G-R; `11` §3). Each rung targets an equal slice of
 * `amountUsd`; the equivalent base qty is expressed in whole lot-step quanta and
 * the spare quanta from rounding are handed to the largest fractional remainders
 * first — ties broken toward the lower (earlier) rung index, a deterministic
 * total order so repeated calls are byte-identical.
 *
 * Per-rung feasibility (`checkFeasibility`) is applied after the split:
 * individually infeasible rungs are **dropped** (fewer rungs than input), but if
 * the **top** rung (`rungPrices[0]`, the most favorable price per §G-R) is itself
 * infeasible the whole ladder is skipped (`[]`).
 */
export function splitLadder(amountUsd: number, rungPrices: number[], instrument: Instrument): Rung[] {
  const rungCount = rungPrices.length
  if (rungCount === 0) return []

  const step = instrument.amountPrecision
  const perRungUsd = amountUsd / rungCount

  // Ideal qty per rung, measured in lot-step quanta.
  const rungs = rungPrices.map((price, index) => {
    const units = perRungUsd / price / instrument.contractSize / step
    const whole = Math.floor(units + RATIO_EPSILON)
    return { index, price, whole, remainder: units - whole, extra: 0 }
  })

  // Largest-remainder: distribute the quanta lost to per-rung flooring.
  const idealTotal = Math.round(rungs.reduce((sum, r) => sum + r.whole + r.remainder, 0))
  let spare = idealTotal - rungs.reduce((sum, r) => sum + r.whole, 0)
  const byRemainder = [...rungs].sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (const rung of byRemainder) {
    if (spare <= 0) break
    rung.extra = 1
    spare--
  }

  const placed: Rung[] = []
  for (const rung of rungs) {
    const qty = (rung.whole + rung.extra) * step
    const feasible = checkFeasibility(qty, rung.price, instrument).ok
    if (rung.index === 0 && !feasible) return [] // top rung infeasible → skip whole ladder
    if (feasible) placed.push({ price: rung.price, qty })
  }
  return placed
}
