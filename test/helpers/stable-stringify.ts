/**
 * Deterministic JSON: recursively sorts object keys so the same value always
 * serializes to the same bytes, regardless of insertion order. Used by the
 * events-log trace writer to keep the golden artifact byte-stable (task 0090;
 * spec 0000 §6 — trace is the replay artifact). `undefined` fields are dropped
 * (they are absent in JSON anyway).
 */

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) sorted[key] = sortKeys(child)
    }
    return sorted
  }
  return value
}
