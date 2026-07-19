/**
 * Preflight unit tests (task 0140; `12` §3 ordered checks / `13` §6 skip-vs-reject).
 * Table-driven: one case per check, plus an ordering case proving the short-circuit.
 */

import { describe, expect, it } from 'vitest'
import type { Instrument } from '../../../../src/core/ports/exchange-adapter.js'
import type { RiskGate } from '../../../../src/core/ports/risk-gate.js'
import { type PreflightSnapshot, runPreflight } from '../../../../src/core/runtime/preflight.js'
import { createRiskGate } from '../../../../src/risk/gate.js'

const INSTRUMENT: Instrument = {
  normalized: 'BTC',
  venueSymbol: 'BTCUSDT',
  contractSize: 1,
  pricePrecision: 0.1,
  amountPrecision: 0.001,
  minNotional: 5,
  minQty: 0.001,
  fundingIntervalHours: 8,
}

/** A snapshot that passes every check; each test overrides just the field under test. */
const PASS: PreflightSnapshot = {
  killSwitch: 'off',
  openIntentCount: 0,
  breakerOpen: false,
  amountUsd: 50,
  leverage: 1,
  balance: { asset: 'USDT', free: 10_000, used: 0 },
  qty: 0.01,
  price: 60_000,
  instrument: INSTRUMENT,
  accountSetupComplete: true,
  marketStatus: 'trading',
}

const ALLOW_ALL: RiskGate = { check: () => ({ allowed: true }) }

function run(overrides: Partial<PreflightSnapshot>, gate: RiskGate = ALLOW_ALL) {
  return runPreflight({ ...PASS, ...overrides }, gate, 'BTC')
}

describe('runPreflight', () => {
  it('passes when every check is satisfied', () => {
    expect(run({})).toEqual({ kind: 'pass' })
  })

  it('rejects with kill_switch when the switch is not off', () => {
    expect(run({ killSwitch: 'paused' })).toEqual({ kind: 'reject', errorCode: 'kill_switch' })
    expect(run({ killSwitch: 'flatten' })).toEqual({ kind: 'reject', errorCode: 'kill_switch' })
  })

  it('rejects with the risk gate code when the gate denies', () => {
    const gate = createRiskGate({ maxConcurrentIntents: 1, maxNotionalUsd: 100 })
    expect(run({ openIntentCount: 1 }, gate)).toEqual({
      kind: 'reject',
      errorCode: 'risk_max_concurrent_intents',
    })
    expect(run({ amountUsd: 200 }, gate)).toEqual({ kind: 'reject', errorCode: 'risk_max_notional_usd' })
    expect(run({ breakerOpen: true }, gate)).toEqual({ kind: 'reject', errorCode: 'risk_breaker_open' })
  })

  it('rejects with insufficient_balance when balance is unknown (fail-closed)', () => {
    expect(run({ balance: undefined })).toEqual({ kind: 'reject', errorCode: 'insufficient_balance' })
  })

  it('rejects with insufficient_balance when free < amountUsd / leverage', () => {
    // Needs 100/2 = 50 margin; only 40 free.
    const snap = { amountUsd: 100, leverage: 2, balance: { asset: 'USDT', free: 40, used: 0 } }
    expect(run(snap)).toEqual({ kind: 'reject', errorCode: 'insufficient_balance' })
  })

  it('skips when the price is unknown (fail-closed)', () => {
    expect(run({ price: undefined })).toEqual({ kind: 'skip' })
  })

  it('skips when the order is infeasible (below min notional)', () => {
    // qty*price = 0.01 * 100 = 1 < minNotional 5.
    expect(run({ price: 100 })).toEqual({ kind: 'skip' })
  })

  it('rejects with account_setup_incomplete when setup has not run', () => {
    expect(run({ accountSetupComplete: false })).toEqual({
      kind: 'reject',
      errorCode: 'account_setup_incomplete',
    })
  })

  it('skips when the market is not trading', () => {
    expect(run({ marketStatus: 'halted' })).toEqual({ kind: 'skip' })
    expect(run({ marketStatus: 'delisted' })).toEqual({ kind: 'skip' })
  })

  it('short-circuits in order: kill switch wins over a failing balance', () => {
    expect(run({ killSwitch: 'paused', balance: undefined })).toEqual({
      kind: 'reject',
      errorCode: 'kill_switch',
    })
  })
})
