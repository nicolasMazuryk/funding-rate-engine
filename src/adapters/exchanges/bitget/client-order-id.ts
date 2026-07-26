/**
 * `clientOrderId` → Bitget `clientOid` — a **length guard, not a codec**.
 *
 * The engine's idempotency key (`11` §4, `src/core/order-id/client-order-id.ts`) is
 * `` `${intentId}-${leg}-${attempt}` `` — e.g. `BTC-28710000-entry-1` — inside the charset
 * `[A-Za-z0-9_-]`, capped at 36 chars. Bitget documents `clientOid` as
 * `^[\.A-Z\:/a-z0-9_-]{1,32}$`: hyphens and underscores are **fine** (unlike OKX, which needs
 * a real escape codec in `../okx/client-order-id.ts`), but the ceiling is **32**, four shorter
 * than the core's cap. So the id goes out verbatim and comes back verbatim — there is no
 * decode path, and the only thing that can go wrong is length.
 *
 * That single failure mode is still fail-loud (`10` §4): an over-long id must not be sent
 * under a truncated key, because a truncated key is not idempotent — a retry would re-derive
 * the *untruncated* id, and the venue would accept a second live order for the same leg.
 */

/** Bitget `clientOid` ceiling — four shorter than the core's 36-char cap, hence the guard. */
export const BITGET_MAX_CLIENT_OID_LEN = 32

/** The charset Bitget documents for `clientOid`; the engine's ids are a strict subset. */
const CLIENT_OID_CHARSET = /^[.A-Z:/a-z0-9_-]+$/

/**
 * Engine `clientOrderId` → Bitget `clientOid` (identity, guarded). Throws when the id exceeds
 * {@link BITGET_MAX_CLIENT_OID_LEN} or carries a character Bitget would reject — both mean the
 * order must not be sent, not that it should be sent under a different key.
 */
export function toVenueClientOid(clientOrderId: string): string {
  if (clientOrderId.length > BITGET_MAX_CLIENT_OID_LEN) {
    throw new Error(
      `bitget clientOid: '${clientOrderId}' is ${clientOrderId.length} chars, over the ${BITGET_MAX_CLIENT_OID_LEN} limit`,
    )
  }
  if (!CLIENT_OID_CHARSET.test(clientOrderId)) {
    throw new Error(`bitget clientOid: '${clientOrderId}' carries a character outside the venue charset`)
  }
  return clientOrderId
}

/**
 * Bitget `clientOid` → engine `clientOrderId`. The echo is verbatim, so this is the identity —
 * it exists so the stream/order code reads the same as the OKX sibling's decode step, and so a
 * frame carrying an id this engine could never have produced (over-long, wrong charset) is
 * **dropped** rather than driving some other intent's FSM.
 */
export function fromVenueClientOid(clientOid: string): string | undefined {
  if (clientOid.length === 0 || clientOid.length > BITGET_MAX_CLIENT_OID_LEN) return undefined
  return CLIENT_OID_CHARSET.test(clientOid) ? clientOid : undefined
}
