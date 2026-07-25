/**
 * Captured-base WS frame loader — backs `public-stream.test.ts`'s factory **defaults** with a
 * real venue shape from `test/fixtures/bybit/public-ws/frames.jsonl`, captured via
 * `npm run capture -- --venue bybit --set public-ws` (credential-free, public feed). Tests
 * still build each case via `overrides`-spread factories, so a field a test does not override
 * carries a real value instead of a hand-typed guess.
 *
 * Two frames matter here, and the capture contains both: the initial `snapshot` (every ticker
 * field) and a later `delta` (only the changed fields — the captured one carries just
 * `bid1Price`/`bid1Size`/`symbol`, i.e. neither `lastPrice` nor `fundingRate`). That delta is
 * the venue's own proof of the "absent field must never publish a zero" rule.
 *
 * The private-WS set needs testnet credentials, which this workspace does not have, so
 * `private-stream.test.ts` stays hand-authored (same reason Binance's `ACCOUNT_UPDATE` base is).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { BybitTickerFrame } from '../../../../../src/adapters/exchanges/bybit/public-stream.js'

function loadJsonl(relPath: string): unknown[] {
  const url = new URL(relPath, import.meta.url)
  const text = readFileSync(fileURLToPath(url), 'utf8').trim()
  return text.length === 0 ? [] : text.split('\n').map((line) => JSON.parse(line))
}

const PUBLIC_FRAMES = loadJsonl('../../../../fixtures/bybit/public-ws/frames.jsonl') as BybitTickerFrame[]

function required(frame: BybitTickerFrame | undefined, what: string): BybitTickerFrame {
  if (!frame) throw new Error(`ws-fixtures: no captured '${what}' tickers frame — recapture with npm run capture`)
  return frame
}

/** The captured `tickers.<SYM>` **snapshot** — the full ticker payload. */
export const CAPTURED_TICKER_SNAPSHOT: BybitTickerFrame = required(
  PUBLIC_FRAMES.find((f) => f.type === 'snapshot'),
  'snapshot',
)

/** A captured `tickers.<SYM>` **delta** — changed fields only (no `lastPrice`/`fundingRate`). */
export const CAPTURED_TICKER_DELTA: BybitTickerFrame = required(
  PUBLIC_FRAMES.find((f) => f.type === 'delta'),
  'delta',
)
