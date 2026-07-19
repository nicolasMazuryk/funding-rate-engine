/**
 * Single-field numeric bound check, mirroring `schema.ts`'s `applyBounds` logic
 * without rebuilding a Zod chain. Used by `delta-merge.ts` to re-validate a single
 * overridden field against its canonical bound (`09_configuration.md` §4: deltas
 * are re-validated against the same bounds). Returns a human-readable violation
 * message, or `undefined` when the value is within bounds.
 */

import type { Bound } from './canonical.js'

export function boundViolation(value: number, bound: Bound | undefined): string | undefined {
  if (!bound) return undefined
  if (bound.min !== undefined) {
    if (bound.exclusiveMin ? value <= bound.min : value < bound.min) {
      return `value ${value} below ${bound.exclusiveMin ? '>' : '>='} ${bound.min}`
    }
  }
  if (bound.max !== undefined) {
    if (bound.exclusiveMax ? value >= bound.max : value > bound.max) {
      return `value ${value} above ${bound.exclusiveMax ? '<' : '<='} ${bound.max}`
    }
  }
  return undefined
}
