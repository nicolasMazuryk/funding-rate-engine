/**
 * ccxt market payload loader for the Bitget adapter unit tests. Fixtures live under
 * `test/fixtures/bitget/markets/` — a mix of `npm run capture -- --venue bitget --set markets`
 * generated (the plain 8 h BTC row, both multiplier prefixes, the 4 h and 1 h cadences, the
 * `1INCH` digit-base trap) and hand-authored synthetic (see that dir's `manifest.json`
 * `synthetic` list) JSON. JSON is read at call time (no `resolveJsonModule`) and cast to the
 * ccxt shape — the adapter code tolerates ccxt's `null`/absent fields, which is exactly what
 * these fixtures exercise.
 *
 * Unlike the OKX sibling there is no companion funding-rate loader: on Bitget the funding
 * interval is a field on the market row itself (`info.fundInterval`, in hours), so a market
 * fixture alone expresses a 4 h or 1 h symbol.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MarketInterface } from 'ccxt'

function readFixture(name: string): unknown {
  const url = new URL(`../../../../fixtures/bitget/markets/${name}`, import.meta.url)
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))
}

/** Load one fixture market by file stem (e.g. `clean-perp-btc`). */
export function loadMarket(stem: string): MarketInterface {
  return readFixture(`${stem}.json`) as MarketInterface
}

/**
 * Load several fixtures into a ccxt-style `id → market` dictionary.
 *
 * Keyed by venue id, so two stems sharing one id cannot be loaded together — `spot-btc` and
 * `clean-perp-btc` are both `BTCUSDT`, which is the venue's own doing (Bitget reuses the symbol
 * across product types) rather than a fixture mistake. Load the spot row on its own when a test
 * needs to prove the universe filter drops it.
 */
export function loadMarkets(stems: readonly string[]): Record<string, MarketInterface> {
  const dict: Record<string, MarketInterface> = {}
  for (const stem of stems) {
    const market = loadMarket(stem)
    dict[market.id as string] = market
  }
  return dict
}
