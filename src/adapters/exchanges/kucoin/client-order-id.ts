/**
 * `clientOrderId` → KuCoin `clientOid` — a **length guard, not a codec** (Bitget's shape).
 *
 * The question this file exists to answer (task 0460): KuCoin's docs place a `str(uuid.uuid4())`
 * in every worked example, and if the venue actually *demanded* UUID form the engine's id could
 * not travel verbatim — an adapter-local `clientOrderId → uuid` map would then be a submit-time,
 * in-memory idempotency key, which is exactly what `11` §4 forbids (a crash between submit and
 * ack would lose the mapping and a retry would place a second live order under a fresh uuid).
 *
 * It does not. The venue documents `clientOid` as a **unique string of at most 40 characters**;
 * the UUID is a convention in the examples, not a constraint. The engine's key
 * (`` `${intentId}-${leg}-${attempt}` ``, e.g. `BTC-28710000-entry-1`, charset `[A-Za-z0-9_-]`,
 * capped at 36) is a strict subset of that, and 36 ≤ 40 — so the id goes out verbatim, comes
 * back verbatim, and there is no map and no decode step.
 *
 * The one remaining failure mode is length, and it stays fail-loud (`10` §4): an over-long id
 * must not be sent truncated, because a truncated key is not idempotent — a retry would
 * re-derive the untruncated id and the venue would accept a second live order for the same leg.
 */

/** KuCoin `clientOid` ceiling — above the core's 36-char cap, so the guard should never fire. */
export const KUCOIN_MAX_CLIENT_OID_LEN = 40

/** The charset the engine's ids use; KuCoin accepts a superset (any unique string). */
const CLIENT_OID_CHARSET = /^[A-Za-z0-9_-]+$/

/**
 * Engine `clientOrderId` → KuCoin `clientOid` (identity, guarded). Throws when the id exceeds
 * {@link KUCOIN_MAX_CLIENT_OID_LEN} or carries a character outside the engine's own charset —
 * both mean the order must not be sent, not that it should be sent under a different key.
 */
export function toVenueClientOid(clientOrderId: string): string {
  if (clientOrderId.length === 0 || clientOrderId.length > KUCOIN_MAX_CLIENT_OID_LEN) {
    throw new Error(
      `kucoin clientOid: '${clientOrderId}' is ${clientOrderId.length} chars, outside 1..${KUCOIN_MAX_CLIENT_OID_LEN}`,
    )
  }
  if (!CLIENT_OID_CHARSET.test(clientOrderId)) {
    throw new Error(`kucoin clientOid: '${clientOrderId}' carries a character outside the engine charset`)
  }
  return clientOrderId
}

/**
 * KuCoin `clientOid` → engine `clientOrderId`. The echo is verbatim, so this is the identity —
 * it exists so a frame carrying an id this engine could never have produced (over-long, wrong
 * charset) is **dropped** rather than driving some other intent's FSM. It is a shape filter, not
 * an ownership check: a UUID from another client on the same account is inside this charset, and
 * the engine's own intent-id lookup is what rejects it downstream.
 */
export function fromVenueClientOid(clientOid: string): string | undefined {
  if (clientOid.length === 0 || clientOid.length > KUCOIN_MAX_CLIENT_OID_LEN) return undefined
  return CLIENT_OID_CHARSET.test(clientOid) ? clientOid : undefined
}
