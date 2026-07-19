/**
 * Golden replay test (task 0090/0170; spec 0000 §6, §8). Runs the shared skeleton
 * scenario on a virtual clock + real sim venue + real WAL, capturing one unified
 * deterministic JSONL trace (`skeleton.trace.golden.jsonl` — header + events +
 * transitions in one artifact, `docs/trace-format.md`) and comparing it
 * byte-for-byte against the committed fixture. It then routes the captured trace
 * through the shared `replayTrace` engine against the golden and asserts the
 * transitions reproduce exactly — the same code path `scripts/replay.ts` uses. A
 * second test runs the scenario twice and asserts identical bytes (no ordering
 * flakiness — DoD #2).
 *
 * Regenerate the fixture after an intentional trace change:
 *
 *   rm test/golden/fixtures/skeleton.trace.golden.jsonl
 *   UPDATE_GOLDEN=1 npx vitest run test/golden/skeleton.test.ts
 *   npx vitest run test/golden/skeleton.test.ts   # confirm it passes against the regenerated file
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatReplayResult, replayTrace } from '../../src/replay/replay-engine.js'
import { buildSkeletonEngine } from '../helpers/build-skeleton-engine.js'
import { runSkeletonScenario, START_MS } from '../helpers/skeleton-scenario.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const TRACE_GOLDEN = join(FIXTURES, 'skeleton.trace.golden.jsonl')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeleton-golden-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Run the scenario once against fresh tmp files and return the unified trace's raw bytes + its path. */
function captureTrace(suffix: string): { readonly path: string; readonly bytes: string } {
  const walPath = join(dir, `skeleton${suffix}.wal.jsonl`)
  const tracePath = join(dir, `skeleton${suffix}.trace.jsonl`)
  const h = buildSkeletonEngine({ startMs: START_MS, walPath, tracePath })
  runSkeletonScenario(h)
  h.engine.dispose()
  h.wal.close()
  h.trace?.close()
  return { path: tracePath, bytes: readFileSync(tracePath, 'utf8') }
}

describe('golden skeleton replay', () => {
  it('captures a trace matching the golden fixture and replays to identical transitions', () => {
    const trace = captureTrace('-run')

    if (UPDATE) writeFileSync(TRACE_GOLDEN, trace.bytes)

    expect(existsSync(TRACE_GOLDEN), 'run with UPDATE_GOLDEN=1 to generate the fixture').toBe(true)
    expect(trace.bytes).toBe(readFileSync(TRACE_GOLDEN, 'utf8'))

    // Route the captured trace through the shared replay engine against the golden.
    const result = replayTrace({ file: trace.path, expectFile: TRACE_GOLDEN })
    expect(result.match, formatReplayResult(result)).toBe(true)
  })

  it('is byte-identical across two consecutive runs (no ordering flakiness)', () => {
    const first = captureTrace('-a')
    const second = captureTrace('-b')
    expect(second.bytes).toBe(first.bytes)
  })
})
