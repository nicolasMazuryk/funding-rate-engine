/**
 * Engine-side conditional stop (`05_strategy_4_1a.md` §2 step 1) — pure core.
 *
 * S4.1a's SL is armed **at ladder-placement time**, before any rung fills, anchored
 * to the precomputed fill-weighted `P_avg_full`. Unlike the resting reduce-only SL of
 * S2/S3a it is *not* an exchange order until a position exists: the engine holds it in
 * memory, evaluates it on every `MarketTick`, and market-closes whatever qty is
 * currently filled on trigger. This util is the reusable primitive (0340 S4.2a is a
 * degenerate 1-rung ladder that reuses it).
 *
 * Depends on nothing but the `Side` value type + arithmetic — no I/O, no engine state.
 */

import type { Side } from '../ports/exchange-adapter.js'

/** One armed engine-side stop: the intent it guards, its trigger price, and the position side it protects. */
export interface ConditionalStop {
  readonly intentId: string
  /** Price at which the stop fires (raw; the engine market-closes, so no tick-snap needed). */
  readonly triggerPrice: number
  /** The entry (position) side — a long stops on a fall to the trigger, a short on a rise. */
  readonly side: Side
}

/**
 * Has `price` reached the stop? A long position triggers when price falls **to or below**
 * the trigger; a short when it rises **to or above** it (`05` §2 / §3 gap-through row).
 */
export function isTriggered(stop: ConditionalStop, price: number): boolean {
  return stop.side === 'long' ? price <= stop.triggerPrice : price >= stop.triggerPrice
}
