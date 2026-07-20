/**
 * Hand-captured ccxt market payload loader for the Binance adapter unit tests.
 * JSON is read at call time (no `resolveJsonModule`) and cast to the ccxt shape —
 * the adapter code tolerates ccxt's `null`-for-absent fields, which is exactly what
 * these fixtures exercise. The real capture tool lands in task 0250.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MarketInterface } from 'ccxt'

/** Load one fixture market by file stem (e.g. `clean-perp-btc`). */
export function loadMarket(stem: string): MarketInterface {
  const url = new URL(`./fixtures/${stem}.json`, import.meta.url)
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
