/**
 * Summary artifact writer + exit-code rule (task 0260). Reuses the capture tool's
 * deterministic JSON writer (`src/capture/fixture-writer.ts`) so the summary sorts
 * keys the same way fixtures do. Skips never fail the run — only `failed > 0` does
 * (spec `0000` §3: skip-with-reason is a documented, expected outcome on testnet).
 */

import { writeJsonFixture } from '../capture/fixture-writer.js'
import type { TestnetSummary } from './types.js'

export function exitCodeFor(summary: TestnetSummary): number {
  return summary.failed > 0 ? 1 : 0
}

export function writeSummary(path: string, summary: TestnetSummary): void {
  writeJsonFixture(path, summary)
}

/** Human-readable table for stdout — one line per check, machine summary stays in the JSON. */
export function formatSummaryTable(summary: TestnetSummary): string {
  const header = `testnet: ${summary.venue} — ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (${summary.total} total, ${summary.durationMs}ms)`
  const rows = summary.results.map((r) => {
    const tag = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'SKIP'
    const reason = r.reason !== undefined ? ` — ${r.reason}` : ''
    return `  [${tag}] ${r.name} (${r.specRef}, ${r.durationMs}ms)${reason}`
  })
  return [header, ...rows].join('\n')
}
