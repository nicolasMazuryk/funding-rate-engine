/**
 * Scenario: **funding gate** (task 0290; `00_globals.md` §6, `02` §2/§3). Wires the pure
 * {@link createFundingGate} to a `simHarness()` (virtual clock + real bus + sim venue): the
 * gate polls `sim.fundingIncome` for its REST safety net and is fed WS `FundingFeeAccrued`
 * off the bus. Covers the 5 DoD cases (WS open, REST open, timeout, duplicate, off-by-6 s
 * miss) and captures one deterministic gate-trace golden (a **direct byte-compare** — the
 * standalone gate emits no WAL transitions, so there is nothing for `replayTrace` to
 * round-trip; the intentional deviation from the skeleton golden).
 *
 * Regenerate the fixture after an intentional gate-trace change:
 *   UPDATE_GOLDEN=1 npx vitest run test/scenarios/funding-gate.test.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFundingGate, type GateSignal } from '../../src/core/runtime/funding-gate.js'
import { createTraceFile, type TraceFile } from '../../src/replay/trace-file.js'
import { type TempDir, tempDir } from '../helpers/temp-dir.js'
import { simHarness } from './sim-harness.js'

const SETTLE = 100_000
const TIMEOUT_S = 30

/** Flush queued microtasks so the async REST poll's `.then` resolves after a clock advance. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

/** `simHarness` + a gate wired to `sim.fundingIncome` (REST) and the bus (WS), collecting its signals. */
function gateHarness(trace?: TraceFile) {
  const h = simHarness(0)
  const signals: GateSignal[] = []
  const gate = createFundingGate({
    clock: h.clock,
    poll: (symbol, range) => h.sim.fundingIncome(symbol, range),
    observer: (s) => {
      signals.push(s)
      if (!trace) return
      if (s.type === 'GateOpened') {
        trace.recordGate({
          ts: h.clock.now(),
          intentId: s.intentId,
          event: 'funding_gate_opened',
          source: s.source,
          offsetS: s.tDropOffsetS,
        })
      } else {
        trace.recordGate({ ts: h.clock.now(), intentId: s.intentId, event: 'funding_gate_closed', reason: s.reason })
      }
    },
  })
  h.bus.subscribe((e) => {
    if (e.type === 'FundingFeeAccrued') gate.onFundingFee(e)
  })
  return { ...h, gate, signals }
}

/** Open a 1-BTC long at 60k so a settlement has a position to accrue against. */
async function openLong(h: ReturnType<typeof gateHarness>): Promise<void> {
  h.sim.setPrice('BTC', 60_000)
  await h.sim.placeOrder({ symbol: 'BTC', side: 'long', type: 'market', qty: 0.001, clientOrderId: 'entry' })
}

const opens = (s: readonly GateSignal[]) => s.filter((x) => x.type === 'GateOpened')
const timeouts = (s: readonly GateSignal[]) =>
  s.filter((x): x is Extract<GateSignal, { type: 'GateClosed' }> => x.type === 'GateClosed' && x.reason === 'timeout')

describe('scenario: funding gate', () => {
  it('1. WS fee at T_settle+4 s opens the gate (source ws, tDropOffsetS 4); poll sees nothing', async () => {
    const h = gateHarness()
    await openLong(h)
    h.gate.arm({ intentId: 'g1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: TIMEOUT_S })
    h.sim.settleFunding('BTC', -0.4, SETTLE + 4_000) // T_drop 4 s after T_settle, within ±5 s
    h.clock.advanceTo(SETTLE + 3_000) // poll fires but the gate is already open → no-op
    await flush()
    expect(opens(h.signals)[0]).toMatchObject({ source: 'ws', tDropOffsetS: 4 })
  })

  it('2. dropped WS but ledger credit → REST poll opens the gate (source rest)', async () => {
    const h = gateHarness()
    await openLong(h)
    h.gate.arm({ intentId: 'g1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: TIMEOUT_S })
    h.sim.dropFundingFee() // WS event suppressed; the income ledger still records the credit
    h.sim.settleFunding('BTC', -0.4, SETTLE)
    h.clock.advanceTo(SETTLE + 3_000)
    await flush()
    expect(opens(h.signals)[0]).toMatchObject({ source: 'rest', tDropOffsetS: 0 })
  })

  it('3. no accrual → timeout fires exactly at T_settle+timeout (not one ms before)', async () => {
    const h = gateHarness()
    h.gate.arm({ intentId: 'g1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: TIMEOUT_S })
    h.clock.advanceTo(SETTLE + TIMEOUT_S * 1_000 - 1)
    await flush()
    expect(timeouts(h.signals)).toHaveLength(0)
    h.clock.advanceTo(SETTLE + TIMEOUT_S * 1_000)
    await flush()
    expect(timeouts(h.signals)).toHaveLength(1)
    expect(opens(h.signals)).toHaveLength(0)
  })

  it('4. duplicate WS fee opens the gate exactly once', async () => {
    const h = gateHarness()
    await openLong(h)
    h.gate.arm({ intentId: 'g1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: TIMEOUT_S })
    h.sim.scriptFault({ matches: (e) => e.type === 'FundingFeeAccrued', action: 'duplicate', count: 1 })
    h.sim.settleFunding('BTC', -0.4, SETTLE)
    await flush()
    expect(opens(h.signals)).toHaveLength(1)
  })

  it('5. fee 6 s off T_settle is outside ±5 s → no match, gate times out', async () => {
    const h = gateHarness()
    await openLong(h)
    h.gate.arm({ intentId: 'g1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: TIMEOUT_S })
    h.sim.settleFunding('BTC', -0.4, SETTLE + 6_000) // outside ±5 s, and future-filtered from the poll
    h.clock.advanceTo(SETTLE + 3_000)
    await flush()
    expect(opens(h.signals)).toHaveLength(0)
    h.clock.advanceTo(SETTLE + TIMEOUT_S * 1_000)
    await flush()
    expect(timeouts(h.signals)).toHaveLength(1)
  })
})

// ── golden: a captured gate-trace fixture, byte-compared (UPDATE_GOLDEN pattern) ──

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const TRACE_GOLDEN = join(FIXTURES, 'funding-gate.trace.golden.jsonl')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

let tmp: TempDir
beforeEach(() => {
  tmp = tempDir('funding-gate-golden-')
})
afterEach(() => {
  tmp.dispose()
})

/** Run the deterministic WS-open case, writing every gate signal to a trace file; return its bytes. */
async function captureGateTrace(suffix: string): Promise<{ readonly bytes: string }> {
  const tracePath = tmp.path(`funding-gate${suffix}.trace.jsonl`)
  const trace = createTraceFile({ path: tracePath })
  const h = gateHarness(trace)
  await openLong(h)
  h.gate.arm({ intentId: 'g1', symbol: 'BTC', settleTs: SETTLE, timeoutSeconds: TIMEOUT_S })
  h.sim.settleFunding('BTC', -0.4, SETTLE + 4_000)
  h.clock.advanceTo(SETTLE + 3_000)
  await flush()
  h.gate.dispose()
  trace.close()
  return { bytes: readFileSync(tracePath, 'utf8') }
}

describe('golden: funding-gate trace', () => {
  it('captures a gate trace matching the committed fixture (opened record carries source + offset)', async () => {
    const { bytes } = await captureGateTrace('-run')
    if (UPDATE) writeFileSync(TRACE_GOLDEN, bytes)

    expect(existsSync(TRACE_GOLDEN), 'run with UPDATE_GOLDEN=1 to generate the fixture').toBe(true)
    expect(bytes).toBe(readFileSync(TRACE_GOLDEN, 'utf8'))

    const opened = bytes
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
      .find((r) => r.kind === 'gate' && r.event === 'funding_gate_opened')
    expect(opened).toMatchObject({ source: 'ws', offsetS: 4 })
  })

  it('is byte-identical across two consecutive runs (determinism)', async () => {
    const first = await captureGateTrace('-a')
    const second = await captureGateTrace('-b')
    expect(second.bytes).toBe(first.bytes)
  })
})
