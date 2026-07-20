/**
 * Captured-base WS frame loader (task 0250) — backs the `public-stream.test.ts` /
 * `private-stream.test.ts` factory **defaults** with a real venue shape from
 * `test/fixtures/binance/{public-ws,private-ws}/frames.jsonl`, captured via
 * `npm run capture -- --venue binance --set public-ws|private-ws`. Tests still build
 * each case via the existing `overrides`-spread factories — only the base object
 * changes, so a field a test doesn't override now carries a real value instead of a
 * hand-typed guess. `ACCOUNT_UPDATE` never fired during capture (no live balance/position
 * change in the window), so `accountUpdate`/`position`/`balance` stay hand-authored.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function loadJsonl(relPath: string): unknown[] {
  const url = new URL(relPath, import.meta.url)
  const text = readFileSync(fileURLToPath(url), 'utf8').trim()
  return text.length === 0 ? [] : text.split('\n').map((line) => JSON.parse(line))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const PUBLIC_FRAMES = loadJsonl('../../../../fixtures/binance/public-ws/frames.jsonl')
const PRIVATE_FRAMES = loadJsonl('../../../../fixtures/binance/private-ws/frames.jsonl')

function required(value: Record<string, unknown> | undefined, what: string): Record<string, unknown> {
  if (!value) throw new Error(`ws-fixtures: no captured '${what}' frame — recapture with npm run capture`)
  return value
}

/** One `markPriceUpdate` array entry for BTCUSDT off the captured `!markPrice@arr@1s` frame. */
export const CAPTURED_MARK_PRICE: Record<string, unknown> = required(
  PUBLIC_FRAMES.flatMap((f) => (Array.isArray(f) ? f : []))
    .filter(isRecord)
    .find((m) => m.eventType === 'markPriceUpdate' && m.symbol === 'BTCUSDT'),
  'markPriceUpdate',
)

/** One captured `aggTrade` frame. */
export const CAPTURED_AGG_TRADE: Record<string, unknown> = required(
  PUBLIC_FRAMES.filter(isRecord).find((m) => m.eventType === 'aggTrade'),
  'aggTrade',
)

/** The `order` sub-object of a captured `ORDER_TRADE_UPDATE` user-data frame. */
export const CAPTURED_ORDER_TRADE_UPDATE_ORDER: Record<string, unknown> = required(
  (() => {
    const frame = PRIVATE_FRAMES.filter(isRecord).find((m) => m.eventType === 'ORDER_TRADE_UPDATE')
    return frame && isRecord(frame.order) ? frame.order : undefined
  })(),
  'ORDER_TRADE_UPDATE',
)
