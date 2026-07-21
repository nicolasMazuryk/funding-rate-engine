/**
 * Golden replay test — **Strategy S2, trailing-retracement tp_hit path** (task 0310; `03` §2).
 * Mirrors `s1-ws.test.ts`: runs the shared S2 scenario on a virtual clock + real sim venue +
 * real WAL, capturing one unified deterministic JSONL trace, comparing it byte-for-byte
 * against the committed fixture, then routing it through the shared `replayTrace` engine to
 * assert the transitions reproduce exactly. A second test proves two runs are byte-identical.
 *
 * Only the **WS-event tp_hit** path is captured: it is synchronous (the gate opens on the
 * bus-delivered `funding_fee`, the TP fills on a bus-delivered tick, all in-band with the
 * engine's dispatch), so it round-trips through the replay engine. The diffed `transition`
 * stream is the exit lifecycle; the TP cancel/re-place shows as `OrderUpdate` `event` records.
 *
 * Regenerate the fixture after an intentional trace change:
 *
 *   rm test/golden/fixtures/s2.trace.golden.jsonl
 *   UPDATE_GOLDEN=1 npx vitest run test/golden/s2.test.ts
 *   npx vitest run test/golden/s2.test.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatReplayResult, replayTrace } from '../../src/replay/replay-engine.js'
import { buildS2Engine, driveToTpExit } from '../helpers/s2-scenario.js'
import { START_MS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const TRACE_GOLDEN = join(FIXTURES, 's2.trace.golden.jsonl')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

let tmp: TempDir

beforeEach(() => {
  tmp = tempDir('s2-golden-')
})

afterEach(() => {
  tmp.dispose()
})

/** Run the tp_hit happy path once against fresh tmp files and return the unified trace's bytes + path. */
function captureTrace(suffix: string): { readonly path: string; readonly bytes: string } {
  const walPath = tmp.path(`s2${suffix}.wal.jsonl`)
  const tracePath = tmp.path(`s2${suffix}.trace.jsonl`)
  const h = buildS2Engine({ startMs: START_MS, walPath, tracePath })
  driveToTpExit(h)
  h.engine.dispose()
  h.wal.close()
  h.trace?.close()
  return { path: tracePath, bytes: readFileSync(tracePath, 'utf8') }
}

describe('golden S2 replay (trailing-retracement tp_hit path)', () => {
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
