/**
 * Deterministic fixture writer (task 0250). Sorted keys via the shared
 * `src/replay/stable-stringify.ts` serializer, so a re-run over unchanged scrubbed
 * input diffs empty. Two shapes: pretty 2-space `.json` for reviewable REST/market
 * fixtures, compact one-object-per-line `.jsonl` for WS message streams.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sortKeys } from '../replay/stable-stringify.js'

export function writeJsonFixture(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(sortKeys(value), null, 2)}\n`)
}

export function writeJsonlFixture(path: string, values: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const lines = values.map((v) => JSON.stringify(sortKeys(v)))
  writeFileSync(path, lines.length > 0 ? `${lines.join('\n')}\n` : '')
}
