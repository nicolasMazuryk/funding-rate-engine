/**
 * Captured-base row loader — backs `public-stream.test.ts`'s factory **defaults** with a real
 * venue payload so a field a test does not override carries a real value instead of a
 * hand-typed guess. The Bybit sibling reads captured WS frames
 * (`test/fixtures/bybit/public-ws/frames.jsonl`); this file reads the committed OKX
 * funding-rate capture instead, and that substitution is the point:
 *
 * OKX's `funding-rate` **WS push and REST response carry the identical row** — the same
 * `fundingRate` / `fundingTime` / `nextFundingTime` / `settState` / `ts` fields, differing
 * only in the envelope (`{arg, data: […]}` vs `{code, data: […]}`). So the rows already
 * captured by `npm run capture -- --venue okx --set markets` (task 0430 phase A) *are* the
 * real WS row shape, and a separate credential-free WS capture would add a second fixture
 * carrying the same bytes.
 *
 * The `tickers` channel has no such REST twin in the committed set, so its rows stay
 * hand-authored — as do the private-channel rows, which need credentials the offline unit
 * tier does not have (the same reason Bybit's and Binance's private bases are hand-authored).
 */

import type { OkxFundingRateRow } from '../../../../../src/adapters/exchanges/okx/public-stream.js'
import { loadFundingRows } from './fixtures.js'

/** The captured 8 h BTC row — a real signed 16-digit rate with every sibling field present. */
export const CAPTURED_FUNDING_ROW: OkxFundingRateRow = required('BTC-USDT-SWAP')

/** The captured 4 h row — the venue's other live cadence, same shape. */
export const CAPTURED_FUNDING_ROW_4H: OkxFundingRateRow = required('LAYER-USDT-SWAP')

function required(instId: string): OkxFundingRateRow {
  const row = loadFundingRows()[instId]
  if (row === undefined) {
    throw new Error(`ws-fixtures: no captured funding-rate row for '${instId}' — recapture with npm run capture`)
  }
  return row as OkxFundingRateRow
}
