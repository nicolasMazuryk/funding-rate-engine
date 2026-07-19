/**
 * Config revision hash (`09_configuration.md` §7): a stable sha256 over the
 * secret-free effective config, logged at startup and stamped on every persisted
 * intent for audit (`15`). Deterministic across runs — same config in, same hash
 * out — so a trade is attributable to an exact config revision.
 *
 * `stableStringify` is local (not imported from `test/helpers/` — wrong direction):
 * production code must not depend on test code.
 */

import { createHash } from 'node:crypto'

/** JSON with object keys sorted recursively, so key order can't perturb the hash. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** sha256 hex over the stable serialization of the (secret-free) effective config. */
export function computeConfigRevisionHash(effectiveConfigWithoutSecrets: unknown): string {
  return createHash('sha256').update(stableStringify(effectiveConfigWithoutSecrets)).digest('hex')
}
