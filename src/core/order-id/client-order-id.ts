/**
 * Deterministic `clientOrderId` codec (`11_execution_and_account_state.md` §4
 * idempotency key `f(intentId, leg, attempt)`). Pure core so the engine (which WALs
 * the id before submit) and the order manager / adapters (which submit + adopt on
 * retry) share **one** definition — no divergent inline templates.
 *
 * Format is the exact string the skeleton engine built inline before this codec
 * existed — `` `${intentId}-${leg}-${attempt}` `` (e.g. `BTC-28710000-entry-1`) —
 * so switching the engine to `makeClientOrderId` is byte-identical and churns no
 * golden/replay fixture. `intentId` may itself contain hyphens (`${symbol}-${ts}`);
 * `leg`/`attempt` are hyphen-free by construction, so {@link parseClientOrderId}
 * splits off exactly the last two `-` segments.
 */

/** Binance caps `newClientOrderId` at 36 chars; the shortest common venue bound. */
export const MAX_CLIENT_ORDER_ID_LEN = 36

/** Venue-safe charset for a client order id (Binance `^[\.A-Za-z0-9_-]{1,36}$`, minus `.`). */
const CLIENT_ORDER_ID_CHARSET = /^[A-Za-z0-9_-]+$/

/** The decoded parts of a client order id. `leg` is a hyphen-free leg code (`entry`/`exit`/…). */
export interface ClientOrderIdParts {
  readonly intentId: string
  readonly leg: string
  readonly attempt: number
}

/**
 * Build the deterministic client order id for one leg-attempt. Fail-loud on a
 * malformed input — a hyphen in `leg`, a non-positive-int `attempt`, an over-long id,
 * or an out-of-charset id all throw (a bad key would silently break adoption /
 * idempotency). The length guard is a guardrail: canonical symbols are short base
 * names, so real ids are well under the cap.
 */
export function makeClientOrderId(parts: ClientOrderIdParts): string {
  const { intentId, leg, attempt } = parts
  if (leg.includes('-')) {
    throw new Error(`makeClientOrderId: leg '${leg}' must be hyphen-free (hyphen is the segment separator)`)
  }
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`makeClientOrderId: attempt '${attempt}' must be a positive integer`)
  }
  const id = `${intentId}-${leg}-${attempt}`
  if (id.length > MAX_CLIENT_ORDER_ID_LEN) {
    throw new Error(`makeClientOrderId: '${id}' exceeds ${MAX_CLIENT_ORDER_ID_LEN} chars`)
  }
  if (!CLIENT_ORDER_ID_CHARSET.test(id)) {
    throw new Error(`makeClientOrderId: '${id}' has characters outside [A-Za-z0-9_-]`)
  }
  return id
}

/**
 * Decode a client order id back into its parts by splitting off the last two `-`
 * segments (`leg`, `attempt`); everything before is the `intentId` (which may itself
 * carry hyphens). Fail-loud on a string this codec did not produce.
 */
export function parseClientOrderId(id: string): ClientOrderIdParts {
  const lastDash = id.lastIndexOf('-')
  const secondLastDash = lastDash > 0 ? id.lastIndexOf('-', lastDash - 1) : -1
  if (secondLastDash <= 0) {
    throw new Error(`parseClientOrderId: '${id}' is not a '<intentId>-<leg>-<attempt>' id`)
  }
  const attempt = Number(id.slice(lastDash + 1))
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`parseClientOrderId: '${id}' has a non-positive-int attempt segment`)
  }
  return {
    intentId: id.slice(0, secondLastDash),
    leg: id.slice(secondLastDash + 1, lastDash),
    attempt,
  }
}
