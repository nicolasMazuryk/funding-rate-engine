/**
 * Golden replay test — **Strategy S4.2a, single-limit `limit_expired` no-fill path** (task 0340;
 * `06` §2 R5). Mirrors `s4-1a.test.ts`: runs the shared S4.2a no-fill scenario on a virtual clock +
 * real sim venue + real WAL, capturing one unified deterministic JSONL trace, comparing it
 * byte-for-byte against the committed fixture, then routing it through the shared `replayTrace`
 * engine to assert the transitions reproduce exactly. A second test proves two runs are byte-identical.
 *
 * The `limit_expired` path is the distinctive S4.2a terminal: the lone limit rests, never crosses,
 * and the venue-side `expireAt` (+ the engine deadline timer at the same instant) terminate it
 * NO_POSITION{limit_expired}. It is fully timer-driven and deterministic, so it round-trips through
 * the replay engine (the resting-limit placement + its EXPIRED/CANCELLED show as `OrderUpdate`
 * `event` records; the diffed `transition` stream is SELECTED → SUBMITTING_ENTRY → NO_POSITION).
 *
 * Regenerate the fixture after an intentional trace change:
 *
 *   rm test/golden/fixtures/s4-2a.trace.golden.jsonl
 *   UPDATE_GOLDEN=1 npx vitest run test/golden/s4-2a.test.ts
 *   npx vitest run test/golden/s4-2a.test.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatReplayResult, replayTrace } from '../../src/replay/replay-engine.js'
import { buildS4_2aEngine, driveToLimitExpired } from '../helpers/s4-2a-scenario.js'
import { START_MS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const TRACE_GOLDEN = join(FIXTURES, 's4-2a.trace.golden.jsonl')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

let tmp: TempDir

beforeEach(() => {
  tmp = tempDir('s4-2a-golden-')
})

afterEach(() => {
  tmp.dispose()
})

/** Run the limit_expired path once against fresh tmp files and return the unified trace's bytes + path. */
function captureTrace(suffix: string): { readonly path: string; readonly bytes: string } {
  const walPath = tmp.path(`s4-2a${suffix}.wal.jsonl`)
  const tracePath = tmp.path(`s4-2a${suffix}.trace.jsonl`)
  const h = buildS4_2aEngine({ startMs: START_MS, walPath, tracePath })
  driveToLimitExpired(h)
  h.engine.dispose()
  h.wal.close()
  h.trace?.close()
  return { path: tracePath, bytes: readFileSync(tracePath, 'utf8') }
}

describe('golden S4.2a replay (single-limit limit_expired path)', () => {
  it('captures a trace matching the golden fixture and replays to identical transitions', () => {
    const trace = captureTrace('-run')

    if (UPDATE) writeFileSync(TRACE_GOLDEN, trace.bytes)

    expect(existsSync(TRACE_GOLDEN), 'run with UPDATE_GOLDEN=1 to generate the fixture').toBe(true)
    expect(trace.bytes).toBe(readFileSync(TRACE_GOLDEN, 'utf8'))

    const result = replayTrace({ file: trace.path, expectFile: TRACE_GOLDEN })
    expect(result.match, formatReplayResult(result)).toBe(true)
  })

  it('is byte-identical across two consecutive runs (no ordering flakiness)', () => {
    const first = captureTrace('-a')
    const second = captureTrace('-b')
    expect(second.bytes).toBe(first.bytes)
  })
})
