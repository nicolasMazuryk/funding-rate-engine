/**
 * ccxt market payload loader for the OKX adapter unit tests. Fixtures live under
 * `test/fixtures/okx/markets/` — a mix of `npm run capture -- --venue okx --set markets`
 * generated (BTC `ctVal 0.01`, XRP `ctVal 100`, a real 4 h symbol, the `1INCH` digit-base
 * trap) and hand-authored synthetic (see that dir's `manifest.json` `synthetic` list) JSON.
 * JSON is read at call time (no `resolveJsonModule`) and cast to the ccxt shape — the adapter
 * code tolerates ccxt's `null`/absent fields, which is exactly what these fixtures exercise.
 *
 * `loadFundingIntervals` is the OKX-only loader: the venue publishes no funding-interval
 * field, so the captured `funding-rate` rows are replayed through the same derivation the
 * adapter uses (`nextFundingTime − fundingTime`).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MarketInterface } from 'ccxt'
import { deriveFundingIntervalHours } from '../../../../../src/adapters/exchanges/okx/instrument.js'

function readFixture(name: string): unknown {
  const url = new URL(`../../../../fixtures/okx/markets/${name}`, import.meta.url)
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))
}

/** Load one fixture market by file stem (e.g. `clean-perp-btc`). */
export function loadMarket(stem: string): MarketInterface {
  return readFixture(`${stem}.json`) as MarketInterface
}

/** Load several fixtures into a ccxt-style `id → market` dictionary. */
export function loadMarkets(stems: readonly string[]): Record<string, MarketInterface> {
  const dict: Record<string, MarketInterface> = {}
  for (const stem of stems) {
    const market = loadMarket(stem)
    dict[market.id as string] = market
  }
  return dict
}

/** The raw captured `funding-rate` rows, keyed by `instId`. */
export function loadFundingRows(): Record<string, { fundingTime?: string; nextFundingTime?: string }> {
  return readFixture('funding-rates.json') as Record<string, { fundingTime?: string; nextFundingTime?: string }>
}

/**
 * `instId → fundingIntervalHours`, derived from the captured rows exactly as the adapter
 * derives it at load — the registry's `intervalHoursByVenueSymbol` argument.
 */
export function loadFundingIntervals(): Map<string, number> {
  const intervals = new Map<string, number>()
  for (const [instId, row] of Object.entries(loadFundingRows())) {
    const hours = deriveFundingIntervalHours(row.fundingTime, row.nextFundingTime)
    if (hours !== undefined) intervals.set(instId, hours)
  }
  return intervals
}
