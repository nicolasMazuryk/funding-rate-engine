/**
 * Config revision hash (`09_configuration.md` §7): a stable sha256 over the
 * secret-free effective config, logged at startup and stamped on every persisted
 * intent for audit (`15`). Deterministic across runs — same config in, same hash
 * out — so a trade is attributable to an exact config revision.
 *
 * `stableStringify` is the one shared serializer under `src/replay/` (the same one
 * the trace-file writer uses) — not the `test/helpers/` copy: production code must
 * not depend on test code.
 */

import { createHash } from 'node:crypto'
import { stableStringify } from '../replay/stable-stringify.js'

export { stableStringify }

/** sha256 hex over the stable serialization of the (secret-free) effective config. */
export function computeConfigRevisionHash(effectiveConfigWithoutSecrets: unknown): string {
  return createHash('sha256').update(stableStringify(effectiveConfigWithoutSecrets)).digest('hex')
}
