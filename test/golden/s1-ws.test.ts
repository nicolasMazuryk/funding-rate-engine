/**
 * Golden replay test — **Strategy S1-WS, WS-event happy path** (task 0300; `02` §2).
 * Mirrors `skeleton.test.ts`: runs the shared S1-WS scenario on a virtual clock + real
 * sim venue + real WAL, capturing one unified deterministic JSONL trace and comparing it
 * byte-for-byte against the committed fixture, then routing it through the shared
 * `replayTrace` engine to assert the transitions reproduce exactly. A second test proves
 * two runs are byte-identical (determinism).
 *
 * Only the **WS-event** path is captured here: it is synchronous (the gate opens on the
 * bus-delivered `funding_fee`, in-band with the engine's dispatch), so it round-trips
 * through the replay engine. The REST-poll and timeout paths are async gate-driven (a
 * `Promise` / a gate-owned timer resolving outside dispatch), so — matching 0290's
 * documented rationale — they are covered by the scenario tests' direct assertions, not
 * this replay round-trip.
 *
 * Regenerate the fixture after an intentional trace change:
 *
 *   rm test/golden/fixtures/s1-ws.trace.golden.jsonl
 *   UPDATE_GOLDEN=1 npx vitest run test/golden/s1-ws.test.ts
 *   npx vitest run test/golden/s1-ws.test.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatReplayResult, replayTrace } from '../../src/replay/replay-engine.js'
import { buildS1WsEngine, driveToWsFundingExit } from '../helpers/s1-ws-scenario.js'
import { START_MS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const TRACE_GOLDEN = join(FIXTURES, 's1-ws.trace.golden.jsonl')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

let tmp: TempDir

beforeEach(() => {
  tmp = tempDir('s1-ws-golden-')
})

afterEach(() => {
  tmp.dispose()
})

/** Run the WS-event happy path once against fresh tmp files and return the unified trace's bytes + path. */
function captureTrace(suffix: string): { readonly path: string; readonly bytes: string } {
  const walPath = tmp.path(`s1-ws${suffix}.wal.jsonl`)
  const tracePath = tmp.path(`s1-ws${suffix}.trace.jsonl`)
  const h = buildS1WsEngine({ startMs: START_MS, walPath, tracePath })
  driveToWsFundingExit(h)
  h.engine.dispose()
  h.wal.close()
  h.trace?.close()
  return { path: tracePath, bytes: readFileSync(tracePath, 'utf8') }
}

describe('golden S1-WS replay (WS funding-fee-event path)', () => {
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
