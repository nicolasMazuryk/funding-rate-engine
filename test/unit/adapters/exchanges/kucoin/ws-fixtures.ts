/**
 * WS frame loader for the KuCoin adapter unit tests — the public set is a **real capture**
 * (`test/fixtures/kucoin/public-ws/frames.jsonl`, via `npm run capture -- --venue kucoin --set
 * public-ws`; both topics are public, so no credentials), the private set is hand-authored
 * (`test/fixtures/kucoin/private-ws/frames.jsonl`). Tests build each case by spreading overrides
 * onto a captured base, so a field a case does not name carries the venue's own bytes instead of
 * a hand-typed guess.
 *
 * **Why this loader filters where the four siblings' do not.** On Binance/Bybit/OKX/Bitget one
 * capture file is one topic. KuCoin's is not, twice over:
 *
 *  1. **two topics in one file** — `/contract/instrument:<SYM>` (funding) and
 *     `/contractMarket/ticker:<SYM>` (last price) were captured over the same socket into the
 *     same JSONL, so a naive `frames[0]` is whichever the venue pushed first;
 *  2. **two subjects inside one topic** — `/contract/instrument` multiplexes `funding.rate` and
 *     `mark.index.price`, and the second one is *not* a price the engine may ever use (feeding a
 *     mark price into `MarketTick` would silently mis-price every entry and exit,
 *     `../../../../../src/adapters/exchanges/kucoin/public-stream.ts`).
 *
 * So selection here is by `(topic prefix, subject)` — the same pair the stream's own type guard
 * keys on — and never by index.
 *
 * The private set could not be captured: KuCoin decommissioned its futures sandbox, so the
 * siblings' recipe (one far-from-market limit on a demo account, then cancel) would place a real
 * order with real money on a live account. See that fixture dir's `manifest.json`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  KucoinOrderData,
  KucoinPositionData,
  KucoinPrivateFrame,
  KucoinSettlementData,
  KucoinWalletData,
} from '../../../../../src/adapters/exchanges/kucoin/private-stream.js'
import type {
  KucoinFundingRateData,
  KucoinPublicFrame,
  KucoinTickerData,
} from '../../../../../src/adapters/exchanges/kucoin/public-stream.js'

function loadJsonl(relPath: string): unknown[] {
  const url = new URL(relPath, import.meta.url)
  const text = readFileSync(fileURLToPath(url), 'utf8').trim()
  return text.length === 0 ? [] : text.split('\n').map((line) => JSON.parse(line))
}

/** Topic prefix carrying `funding.rate` **and** `mark.index.price` — hence the subject filter. */
export const INSTRUMENT_TOPIC = '/contract/instrument'
/** Topic prefix carrying the last traded price. */
export const TICKER_TOPIC = '/contractMarket/ticker'

const PUBLIC_FRAMES = loadJsonl('../../../../fixtures/kucoin/public-ws/frames.jsonl') as KucoinPublicFrame<unknown>[]
const PRIVATE_FRAMES = loadJsonl('../../../../fixtures/kucoin/private-ws/frames.jsonl') as KucoinPrivateFrame<unknown>[]

function required<T>(frame: T | undefined, what: string): T {
  if (frame === undefined) {
    throw new Error(`ws-fixtures: no captured ${what} frame — recapture with npm run capture -- --venue kucoin`)
  }
  return frame
}

/**
 * Every captured public frame on `topicPrefix` with `subject`, in capture order. Both selectors
 * are required: the topic alone does not identify a payload shape on this venue.
 */
export function publicFrames<T>(topicPrefix: string, subject: string): KucoinPublicFrame<T>[] {
  return PUBLIC_FRAMES.filter(
    (f) => typeof f.topic === 'string' && f.topic.startsWith(`${topicPrefix}:`) && f.subject === subject,
  ) as KucoinPublicFrame<T>[]
}

/** The first captured frame for a `(topic, subject)` pair; throws when the capture has none. */
export function publicFrame<T>(topicPrefix: string, subject: string): KucoinPublicFrame<T> {
  return required(publicFrames<T>(topicPrefix, subject)[0], `'${topicPrefix}' '${subject}'`)
}

/** The first captured `funding.rate` push — a signed real rate plus its epoch-**ms** `timestamp`. */
export const CAPTURED_FUNDING_FRAME: KucoinPublicFrame<KucoinFundingRateData> = publicFrame(
  INSTRUMENT_TOPIC,
  'funding.rate',
)

/**
 * The first captured `mark.index.price` push — same topic as the funding frame, different
 * subject. Kept so a test can prove the stream drops it rather than reading `markPrice` as a tick.
 */
export const CAPTURED_MARK_INDEX_FRAME: KucoinPublicFrame<{ markPrice?: number; indexPrice?: number }> = publicFrame(
  INSTRUMENT_TOPIC,
  'mark.index.price',
)

/** The first captured `ticker` push — last price as a string, `ts` in **nanoseconds**. */
export const CAPTURED_TICKER_FRAME: KucoinPublicFrame<KucoinTickerData> = publicFrame(TICKER_TOPIC, 'ticker')

/** Every hand-authored private frame on `topic` (exact match) with `subject`, in file order. */
export function privateFrames<T>(topic: string, subject: string): KucoinPrivateFrame<T>[] {
  return PRIVATE_FRAMES.filter(
    (f) =>
      typeof f.topic === 'string' && (f.topic === topic || f.topic.startsWith(`${topic}:`)) && f.subject === subject,
  ) as KucoinPrivateFrame<T>[]
}

/** The four `symbolOrderChange` frames: `open` → `match` → `filled`, plus a cancelled exit leg. */
export const ORDER_FRAMES: KucoinPrivateFrame<KucoinOrderData>[] = privateFrames(
  '/contractMarket/tradeOrders',
  'symbolOrderChange',
)

/** The `position.change` frame (`currentQty` is **signed**). */
export const POSITION_FRAME: KucoinPrivateFrame<KucoinPositionData> = required(
  privateFrames<KucoinPositionData>('/contract/position', 'position.change')[0],
  "'position.change'",
)

/** The `position.settlement` frame — KuCoin's explicit per-settlement `fundingFee`. */
export const SETTLEMENT_FRAME: KucoinPrivateFrame<KucoinSettlementData> = required(
  privateFrames<KucoinSettlementData>('/contract/position', 'position.settlement')[0],
  "'position.settlement'",
)

/** The `walletBalance.change` frame — exact `availableBalance` / `holdBalance` split. */
export const WALLET_FRAME: KucoinPrivateFrame<KucoinWalletData> = required(
  privateFrames<KucoinWalletData>('/contractAccount/wallet', 'walletBalance.change')[0],
  "'walletBalance.change'",
)
