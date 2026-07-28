/**
 * Why a submit was not accepted (task 0470 phase 6).
 *
 * `placeOrder` is fire-and-forget by design (`11` §3): it answers `{accepted:false}` and
 * publishes the *reason* as an `OrderUpdate{REJECTED|FAILED}` rather than throwing. A check that
 * only reports "the venue did not accept it" therefore throws away the one line that explains
 * the run — an OKX `clOrdId` over its 32-char ceiling was reported as a plain non-acceptance
 * until this existed (0470 §6).
 *
 * Reads the cap's own refusals first (the wrapper never reaches the venue, so its rejection is
 * the whole story), then the bus.
 */

import type { LiveContext } from '../context.js'

/** A one-line explanation of a failed submit, for a check's thrown error. */
export function submitFailureReason(ctx: LiveContext, clientOrderId: string): string {
  const capped = ctx.adapter.cap.rejections.find((r) => r.clientOrderId === clientOrderId)
  if (capped !== undefined) return `refused by the live cap (${capped.kind}): ${capped.reason}`

  const published = ctx.events.find(
    (e) =>
      e.type === 'OrderUpdate' &&
      e.clientOrderId === clientOrderId &&
      (e.status === 'REJECTED' || e.status === 'FAILED'),
  )
  if (published === undefined || published.type !== 'OrderUpdate') return 'no reason was published on the bus'
  return `${published.status}${published.errorKind === undefined ? '' : ` (${published.errorKind})`}: ${
    published.reason ?? 'no reason given'
  }`
}
