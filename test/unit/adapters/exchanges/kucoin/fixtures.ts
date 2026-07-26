/**
 * ccxt market payload loader for the KuCoin adapter unit tests. Fixtures live under
 * `test/fixtures/kucoin/markets/` — a mix of `npm run capture -- --venue kucoin --set markets`
 * generated (the 8 h `XBTUSDTM` row, the sub-unit `ETHUSDTM` and 100 DOGE face values, both name
 * prefixes, the 4 h and 1 h cadences, the `1INCH` digit-base trap, the coin-margined `XBTUSDM`)
 * and hand-authored synthetic (see that dir's `manifest.json` `synthetic` list) JSON. JSON is read
 * at call time (no `resolveJsonModule`) and cast to the ccxt shape — the adapter code tolerates
 * ccxt's `null`/absent fields, which is exactly what these fixtures exercise.
 *
 * Like the Bitget sibling and unlike the OKX one there is no companion funding-rate loader: on
 * KuCoin the funding interval is a field on the market row itself (`info.fundingRateGranularity`,
 * in **milliseconds**), so a market fixture alone expresses a 4 h or 1 h symbol.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MarketInterface } from 'ccxt'

function readFixture(name: string): unknown {
  const url = new URL(`../../../../fixtures/kucoin/markets/${name}`, import.meta.url)
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))
}

/** Load one fixture market by file stem (e.g. `clean-perp-btc`). */
export function loadMarket(stem: string): MarketInterface {
  return readFixture(`${stem}.json`) as MarketInterface
}

/**
 * Load several fixtures into a ccxt-style `id → market` dictionary.
 *
 * Keyed by venue id, so two stems sharing one id cannot be loaded together. On KuCoin no two
 * stems collide (the spot row is `BTC-USDT`, the futures one `XBTUSDTM` — the venue spells the
 * two product types differently), but the helper is kept id-keyed to match ccxt's own shape.
 */
export function loadMarkets(stems: readonly string[]): Record<string, MarketInterface> {
  const dict: Record<string, MarketInterface> = {}
  for (const stem of stems) {
    const market = loadMarket(stem)
    dict[market.id as string] = market
  }
  return dict
}
