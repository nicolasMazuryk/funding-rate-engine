/**
 * Scenario: **kill-switch flatten** (`13` §3/§4, `00_globals.md` §5.2, task 0380). A live MONITORING
 * intent, then `killSwitch.transition('flatten')`: the engine terminalizes the intent to
 * `CLOSED(kill_switch_flatten)` through its reduce-only exit (DoD #4), and the wired `flattenAll`
 * safety net finds the venue already flat. Asserts intent state + WAL payload + venue ground truth.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flattenAll } from '../../src/risk/flatten.js'
import { buildSkeletonEngine } from '../helpers/build-skeleton-engine.js'
import { driveToEntry, INTENT_ID, START_MS } from '../helpers/skeleton-scenario.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'

const BACKOFFS = [250, 1000, 3000] as const

describe('scenario: kill-switch flatten', () => {
  let tmp: TempDir
  beforeEach(() => {
    tmp = tempDir('kill-switch-flatten-')
  })
  afterEach(() => {
    tmp.dispose()
  })

  it('terminalizes a MONITORING intent to CLOSED(kill_switch_flatten) and leaves the venue flat', async () => {
    const h = buildSkeletonEngine({ walPath: tmp.walPath, startMs: START_MS })
    driveToEntry(h)
    expect(h.engine.intentState(INTENT_ID)).toBe('MONITORING')
    expect(await h.exchange.getPositions()).toEqual([{ symbol: 'BTC', side: 'long', qty: 0.001, entryPrice: 60_000 }])

    // Wire the flatten safety net exactly as main.ts does, then flip the switch.
    h.killSwitch.subscribe((state) => {
      if (state === 'flatten') {
        void flattenAll({ exchange: h.exchange, clock: h.clock, bus: h.bus, backoffsMs: BACKOFFS })
      }
    })
    h.killSwitch.transition('flatten')

    // The engine fired the reduce-only exit synchronously → intent CLOSED, venue flat.
    expect(h.engine.intentState(INTENT_ID)).toBe('CLOSED')
    const closed = h.wal.readAll().find((r) => r.intentId === INTENT_ID && r.toState === 'CLOSED')
    expect((closed?.payload as { exitReason?: string } | undefined)?.exitReason).toBe('kill_switch_flatten')
    expect(await h.exchange.getPositions()).toEqual([])
  })
})
