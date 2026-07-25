/**
 * ccxt market payload loader for the Bybit adapter unit tests. Fixtures live under
 * `test/fixtures/bybit/markets/` — a mix of `npm run capture -- --venue bybit --set markets`
 * generated (clean 8h perp, a real 4h symbol, 1000x multiplier) and hand-authored synthetic
 * (see that dir's `manifest.json` `synthetic` list) JSON. JSON is read at call time (no
 * `resolveJsonModule`) and cast to the ccxt shape — the adapter code tolerates ccxt's
 * `null`/absent fields, which is exactly what these fixtures exercise.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MarketInterface } from 'ccxt'

/** Load one fixture market by file stem (e.g. `clean-perp-btc`). */
export function loadMarket(stem: string): MarketInterface {
  const url = new URL(`../../../../fixtures/bybit/markets/${stem}.json`, import.meta.url)
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as MarketInterface
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
