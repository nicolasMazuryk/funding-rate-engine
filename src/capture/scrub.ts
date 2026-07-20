/**
 * Deterministic scrubber (task 0250). Redacts secrets and normalizes volatile fields
 * (timestamps, order/trade ids) via a mapping object so related messages captured in
 * one run stay internally consistent — the same real timestamp/id always scrubs to the
 * same output value. Pure function of (raw payload, maps): same input → same output, so
 * the capture pipeline is idempotent. Scrubbing happens in-memory, before the fixture
 * writer ever sees a payload — the un-scrubbed raw value is never written to disk.
 */

/** Field names carrying secrets — dropped entirely, not just blanked, so no trace remains. */
const SECRET_KEY_PATTERN = /key|secret|signature|passphrase|password/i
/**
 * Secret-shaped string *values*, regardless of field name — e.g. the listen key the
 * lib echoes back as `streamName` on a private-stream frame. Long base62/base64-ish
 * tokens are exactly what a leaked credential looks like; a legitimate field never
 * needs a raw value like this in a committed fixture.
 */
const SECRET_VALUE_PATTERN = /^[A-Za-z0-9+/]{40,}={0,2}$/
const REDACTED = '[REDACTED]'

/** Fixed base epoch so scrubbed timestamps still read as plausible ms-epoch values, not `0`. */
const BASE_EPOCH_MS = 1_700_000_000_000
const TIMESTAMP_STEP_MS = 1_000

function looksLikeEpochMs(n: number): boolean {
  return Number.isFinite(n) && n > 1_000_000_000_000 && n < 10_000_000_000_000
}

/**
 * Last camelCase word of a field name, lowercased (`nextFundingTime` → `time`,
 * `origClientOrderId` → `id`, `limits` → `limits`) — classifying by the trailing word
 * avoids both missing capitalized suffixes (`Time`, `Id`) and false-positiving on an
 * unrelated field that merely ends in the letters `ts` (`limits`).
 */
function lastCamelWord(key: string): string {
  const words = key.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g)
  return (words?.at(-1) ?? key).toLowerCase()
}

function isTimestampKey(key: string): boolean {
  return ['ts', 'time', 'timestamp'].includes(lastCamelWord(key))
}

function isIdKey(key: string): boolean {
  return lastCamelWord(key) === 'id'
}

/** Per-capture-run scrub state: original → normalized, keeping related messages consistent. */
export interface ScrubMaps {
  readonly timestamps: Map<number, number>
  readonly ids: Map<string, string>
}

export function createScrubMaps(): ScrubMaps {
  return { timestamps: new Map(), ids: new Map() }
}

function normalizeTimestamp(value: number, maps: ScrubMaps): number {
  const existing = maps.timestamps.get(value)
  if (existing !== undefined) return existing
  const next = BASE_EPOCH_MS + maps.timestamps.size * TIMESTAMP_STEP_MS
  maps.timestamps.set(value, next)
  return next
}

function normalizeId(value: string, maps: ScrubMaps): string {
  const existing = maps.ids.get(value)
  if (existing !== undefined) return existing
  const next = String(maps.ids.size + 1)
  maps.ids.set(value, next)
  return next
}

export interface ScrubOptions {
  /**
   * Normalize timestamp/id-shaped fields (default `true`). Market metadata (`markets`
   * set) is static reference data, not a per-request/per-fill volatile payload — its
   * `id`/`onboardDate`-style fields are the fixture's actual content, not noise to
   * anonymize, so the `markets` driver passes `false`.
   */
  readonly normalizeVolatile?: boolean
}

/** Scrub one field value given its key name; recurses into nested objects/arrays untouched by name rules. */
function scrubField(key: string, value: unknown, maps: ScrubMaps, opts: Required<ScrubOptions>): unknown {
  if (typeof value === 'string' && SECRET_VALUE_PATTERN.test(value)) return REDACTED
  if (opts.normalizeVolatile) {
    if (typeof value === 'number' && isTimestampKey(key) && looksLikeEpochMs(value)) {
      return normalizeTimestamp(value, maps)
    }
    if (isIdKey(key)) {
      if (typeof value === 'number') return Number(normalizeId(String(value), maps))
      if (typeof value === 'string' && value.length > 0) return normalizeId(value, maps)
    }
  }
  return scrub(value, maps, opts)
}

/** Recursively scrub a raw venue payload: drop secret fields, normalize timestamp/id fields. */
export function scrub(value: unknown, maps: ScrubMaps, opts: ScrubOptions = {}): unknown {
  const resolved: Required<ScrubOptions> = { normalizeVolatile: opts.normalizeVolatile ?? true }
  if (Array.isArray(value)) return value.map((v) => scrub(v, maps, resolved))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) continue // secrets never reach disk
      out[key] = scrubField(key, child, maps, resolved)
    }
    return out
  }
  return value
}
