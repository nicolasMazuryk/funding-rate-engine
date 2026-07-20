/**
 * Deterministic JSON: recursively sorts object keys so the same value always
 * serializes to the same bytes, regardless of insertion order. `undefined`
 * fields are dropped (absent in JSON anyway).
 *
 * The one shared implementation: the config revision hash (`src/config/
 * revision-hash.ts`) and the trace-file writer (`src/replay/trace-file.ts`)
 * both import it, converging what used to be two byte-identical copies. It
 * lives under `src/replay/` (not `src/core/`) so the core-purity Biome rule
 * stays intact — the core never imports it.
 */

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

/** Recursive key sort, exported for other deterministic writers (`src/capture/fixture-writer.ts`). */
export function sortKeys(value: unknown): unknown {
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
