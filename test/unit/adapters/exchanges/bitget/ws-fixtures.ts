/**
 * Captured-base WS frame loader — backs `public-stream.test.ts`'s factory **defaults** with a
 * real venue payload from `test/fixtures/bitget/public-ws/frames.jsonl`, captured via
 * `npm run capture -- --venue bitget --set public-ws` (the `ticker` topic is public, so the
 * capture needs no credentials). Tests build each case by spreading overrides onto that base,
 * so a field a case does not name carries the venue's own bytes instead of a hand-typed guess.
 *
 * **Why this reads a WS capture where the OKX sibling reads a REST one.** OKX's `funding-rate`
 * WS push and its REST response carry the *identical* row, so the markets capture already was
 * the WS row shape and `../okx/ws-fixtures.ts` simply reused it. Bitget has no such twin: the
 * v3 futures `ticker` frame fuses funding *and* last price into one push shape
 * (`{arg:{instType,symbol,topic}, action, ts, data:[row]}`) that no REST endpoint reproduces —
 * in particular the instrument lives on `arg.symbol`, never on the row. So the frames were
 * captured off the live socket directly and are loaded here whole, envelope included.
 *
 * The private-WS set needs credentials this offline tier does not have, so
 * `private-stream.test.ts` stays hand-authored (as on Bybit and Binance).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { BitgetPublicFrame, BitgetTickerRow } from '../../../../../src/adapters/exchanges/bitget/public-stream.js'

function loadJsonl(relPath: string): unknown[] {
  const url = new URL(relPath, import.meta.url)
  const text = readFileSync(fileURLToPath(url), 'utf8').trim()
  return text.length === 0 ? [] : text.split('\n').map((line) => JSON.parse(line))
}

const PUBLIC_FRAMES = loadJsonl(
  '../../../../fixtures/bitget/public-ws/frames.jsonl',
) as BitgetPublicFrame<BitgetTickerRow>[]

function required(frame: BitgetPublicFrame<BitgetTickerRow> | undefined): BitgetPublicFrame<BitgetTickerRow> {
  if (!frame) {
    throw new Error("ws-fixtures: no captured 'ticker' frame — recapture with npm run capture -- --venue bitget")
  }
  return frame
}

/**
 * The first captured `ticker` push — a full snapshot for `BTCUSDT` carrying both signals
 * (`lastPrice` and a real signed `fundingRate`) plus the `arg.symbol` echo the mappers read.
 */
export const CAPTURED_TICKER_FRAME: BitgetPublicFrame<BitgetTickerRow> = required(
  PUBLIC_FRAMES.find((f) => f.arg?.topic === 'ticker'),
)

/** The captured frame's data row on its own, for tests that build their own envelope. */
export const CAPTURED_TICKER_ROW: BitgetTickerRow = required(CAPTURED_TICKER_FRAME).data?.[0] ?? {}
