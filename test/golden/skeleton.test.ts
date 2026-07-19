/**
 * Golden replay test (task 0090; spec 0000 §6, §8). Runs the shared skeleton
 * scenario on a virtual clock + real sim venue + real WAL, capturing two
 * deterministic JSONL streams — the WAL (`skeleton.wal.golden.jsonl`) and the
 * events log (`skeleton.events.golden.jsonl`) — and compares them byte-for-byte
 * against committed fixtures. It also runs the scenario twice and asserts
 * identical bytes both times (no ordering flakiness — DoD #2).
 *
 * Regenerate the fixtures after an intentional trace change:
 *
 *   rm test/golden/fixtures/skeleton.events.golden.jsonl test/golden/fixtures/skeleton.wal.golden.jsonl
 *   UPDATE_GOLDEN=1 npx vitest run test/golden/skeleton.test.ts
 *   npx vitest run test/golden/skeleton.test.ts   # confirm it passes against the regenerated files
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSkeletonEngine } from '../helpers/build-skeleton-engine.js'
import { runSkeletonScenario, START_MS } from '../helpers/skeleton-scenario.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const WAL_GOLDEN = join(FIXTURES, 'skeleton.wal.golden.jsonl')
const EVENTS_GOLDEN = join(FIXTURES, 'skeleton.events.golden.jsonl')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

interface Trace {
  readonly wal: string
  readonly events: string
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'skeleton-golden-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Run the scenario once against fresh tmp files and return their raw bytes. */
function captureTrace(suffix: string): Trace {
  const walPath = join(dir, `skeleton${suffix}.wal.jsonl`)
  const eventsPath = join(dir, `skeleton${suffix}.events.jsonl`)
  const h = buildSkeletonEngine({ startMs: START_MS, walPath, eventsPath })
  runSkeletonScenario(h)
  h.engine.dispose()
  h.wal.close()
  h.traceWriter?.close()
  return { wal: readFileSync(walPath, 'utf8'), events: readFileSync(eventsPath, 'utf8') }
}

describe('golden skeleton replay', () => {
  it('produces byte-identical WAL + events traces against the golden fixtures', () => {
    const trace = captureTrace('-run')

    if (UPDATE) {
      writeFileSync(WAL_GOLDEN, trace.wal)
      writeFileSync(EVENTS_GOLDEN, trace.events)
    }

    expect(existsSync(WAL_GOLDEN), 'run with UPDATE_GOLDEN=1 to generate fixtures').toBe(true)
    expect(trace.wal).toBe(readFileSync(WAL_GOLDEN, 'utf8'))
    expect(trace.events).toBe(readFileSync(EVENTS_GOLDEN, 'utf8'))
  })

  it('is byte-identical across two consecutive runs (no ordering flakiness)', () => {
    const first = captureTrace('-a')
    const second = captureTrace('-b')
    expect(second.wal).toBe(first.wal)
    expect(second.events).toBe(first.events)
  })
})
