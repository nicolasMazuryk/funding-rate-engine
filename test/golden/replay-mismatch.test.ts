/**
 * Replay-mismatch regression (task 0170; DoD #3/#4). Corrupts one recorded
 * `transition` in a copy of the golden trace, then replays the *pristine* golden
 * events against that corrupted expectation via the shared `replayTrace`. The
 * fresh core still produces the correct transitions, so the diff must report
 * `match: false` and pinpoint the corrupted record — naming the intent id and the
 * from/to states (human render) and exposing the machine-readable `firstDivergence`
 * shape (`--json`). This makes the DoD's "corrupt one transition and observe the
 * failure" a permanent, `npm run verify`-covered check, not a manual step.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatReplayResult, replayTrace } from '../../src/replay/replay-engine.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const TRACE_GOLDEN = join(FIXTURES, 'skeleton.trace.golden.jsonl')

let tmp: TempDir

beforeEach(() => {
  tmp = tempDir('replay-mismatch-')
})

afterEach(() => {
  tmp.dispose()
})

/** Copy the golden with the first `transition` record's `toState` mangled; return {path, corrupted}. */
function corruptFirstTransition(): { readonly path: string; readonly toState: string; readonly intentId: string } {
  const lines = readFileSync(TRACE_GOLDEN, 'utf8').split('\n')
  let intentId = ''
  let toState = ''
  const mangled = lines.map((line) => {
    if (line.length === 0) return line
    const record = JSON.parse(line) as { kind: string; toState?: string; intentId?: string }
    if (record.kind === 'transition' && intentId === '') {
      intentId = record.intentId ?? ''
      toState = 'CORRUPTED'
      return JSON.stringify({ ...record, toState })
    }
    return line
  })
  const path = tmp.path('corrupted.trace.jsonl')
  writeFileSync(path, mangled.join('\n'))
  return { path, toState, intentId }
}

describe('replay mismatch detection', () => {
  it('reports match:false and pinpoints the corrupted transition (human render)', () => {
    const { path, intentId } = corruptFirstTransition()

    // Replay the pristine golden events, but diff against the corrupted expectation.
    const result = replayTrace({ file: TRACE_GOLDEN, expectFile: path })

    expect(result.match).toBe(false)
    expect(result.firstDivergence).toBeDefined()
    const d = result.firstDivergence
    if (d === undefined) throw new Error('expected a divergence')
    expect(d.intentId).toBe(intentId)
    expect(d.expected?.toState).toBe('CORRUPTED') // recorded (corrupted) side
    expect(d.actual?.toState).toBe('SUBMITTING_ENTRY') // freshly replayed (correct) side

    const rendered = formatReplayResult(result)
    expect(rendered).toContain('MISMATCH')
    expect(rendered).toContain(intentId)
    expect(rendered).toContain('CORRUPTED')
  })

  it('exposes a JSON-serializable firstDivergence (--json shape)', () => {
    const { path } = corruptFirstTransition()
    const result = replayTrace({ file: TRACE_GOLDEN, expectFile: path })

    const json = {
      match: result.match,
      recordCount: { expected: result.expected.length, actual: result.actual.length },
      firstDivergence: result.firstDivergence,
    }
    const roundTripped = JSON.parse(JSON.stringify(json)) as typeof json

    expect(roundTripped.match).toBe(false)
    expect(roundTripped.firstDivergence).toBeDefined()
    expect(typeof roundTripped.firstDivergence?.index).toBe('number')
    expect(typeof roundTripped.firstDivergence?.seq).toBe('number')
    expect(roundTripped.recordCount.actual).toBeGreaterThan(0)
  })
})
