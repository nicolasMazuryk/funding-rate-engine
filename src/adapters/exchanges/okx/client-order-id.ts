/**
 * `clientOrderId` ↔ OKX `clOrdId` codec — a venue quirk with no analogue on the two prior
 * adapters, and the reason it needs a file rather than an inline `String(...)`.
 *
 * The engine's idempotency key (`11` §4, `src/core/order-id/client-order-id.ts`) is
 * `` `${intentId}-${leg}-${attempt}` `` — e.g. `BTC-28710000-entry-1` — inside the charset
 * `[A-Za-z0-9_-]`, capped at 36 chars. OKX's `clOrdId` is documented as *"a combination of
 * case-sensitive alphanumerics, all numbers, or all letters of **up to 32 characters**"*:
 * **no hyphen, no underscore, and four characters shorter**. Submitting the raw id is a
 * `51000` parameter rejection on every order. Binance (`^[\.A-Za-z0-9_-]{1,36}$`) and Bybit
 * (`orderLinkId`, 36 chars, hyphens fine) both take the id verbatim, so this is the first
 * venue that has to re-spell it.
 *
 * The mapping must be **deterministic** (a retry re-derives the same key, which is what makes
 * `11` §4 idempotency work across a WS timeout) and **reversible** (the private `orders`
 * channel echoes `clOrdId`, and the order FSM is keyed on the engine's id — an undecodable
 * echo would strand the intent). A one-way sanitize plus a submit-time lookup table would
 * satisfy neither after a restart, so this is a real escape codec:
 *
 * | source | encoded |
 * |---|---|
 * | `x` | `xx` |
 * | `-` | `xd` |
 * | `_` | `xu` |
 *
 * `BTC-28710000-entry-1` → `BTCxd28710000xdentryxd1`. Every other character passes through, so
 * an all-alphanumeric id is unchanged and the encoding grows only by the number of escapes.
 * Both directions fail loud (`10` §4): an over-long encode and an unknown escape are bugs, not
 * conditions to paper over — a mis-keyed order is unadoptable on retry.
 */

/** OKX `clOrdId` ceiling — four shorter than the core's 36-char cap, hence the encode guard. */
export const OKX_MAX_CLORDID_LEN = 32

/** The escape character; a literal `x` in the source doubles to keep the mapping injective. */
const ESCAPE = 'x'

/** Escape → the source character it stands for. `xx` is the literal escape itself. */
const UNESCAPE: Readonly<Record<string, string>> = { x: 'x', d: '-', u: '_' }

/** Source character → its two-character escape. Everything absent here passes through. */
const ESCAPE_OF: Readonly<Record<string, string>> = { x: 'xx', '-': 'xd', _: 'xu' }

/**
 * Engine `clientOrderId` → OKX `clOrdId`. Throws when the encoded id would exceed
 * {@link OKX_MAX_CLORDID_LEN} or still carries a character OKX would reject — both mean the
 * order must not be sent, not that it should be sent under a truncated key.
 */
export function toVenueClOrdId(clientOrderId: string): string {
  let encoded = ''
  for (const char of clientOrderId) encoded += ESCAPE_OF[char] ?? char
  if (encoded.length > OKX_MAX_CLORDID_LEN) {
    throw new Error(
      `okx clOrdId: '${clientOrderId}' encodes to ${encoded.length} chars, over the ${OKX_MAX_CLORDID_LEN} limit`,
    )
  }
  if (!/^[A-Za-z0-9]+$/.test(encoded)) {
    throw new Error(`okx clOrdId: '${clientOrderId}' encodes to '${encoded}', which is not alphanumeric`)
  }
  return encoded
}

/**
 * OKX `clOrdId` → engine `clientOrderId`; the exact inverse of {@link toVenueClOrdId}.
 * Returns `undefined` for a string this codec did not produce (a dangling trailing escape or
 * an unknown escape letter) so a stream frame for someone else's order is **dropped**, never
 * decoded into a plausible-looking id that would drive the wrong intent's FSM.
 */
export function fromVenueClOrdId(clOrdId: string): string | undefined {
  let decoded = ''
  for (let i = 0; i < clOrdId.length; i++) {
    const char = clOrdId[i] as string
    if (char !== ESCAPE) {
      decoded += char
      continue
    }
    const source = UNESCAPE[clOrdId[i + 1] ?? '']
    if (source === undefined) return undefined
    decoded += source
    i++
  }
  return decoded
}
