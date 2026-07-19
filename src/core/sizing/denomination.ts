/**
 * Base-unit ↔ venue-unit denomination conversion — pure core (`10` §4).
 *
 * All internal math, sizing and P&L use the **base unit**; a venue that
 * expresses a symbol in multiples (e.g. `1000PEPE`, `contractSize = 1000`)
 * only sees venue/contract units at the adapter/API boundary. These two
 * functions are that boundary conversion and nothing else.
 */

import type { Instrument } from '../ports/exchange-adapter.js'

/** Base-unit count → venue contract count: `baseQty / contractSize` (apply only at the API boundary). */
export function toVenueUnits(baseQty: number, instrument: Instrument): number {
  return baseQty / instrument.contractSize
}

/** Venue contract count → base-unit count: `venueQty × contractSize` (inverse of {@link toVenueUnits}). */
export function fromVenueUnits(venueQty: number, instrument: Instrument): number {
  return venueQty * instrument.contractSize
}
