/**
 * Unit: Bitget account setup (`11` §1). Mirrors the OKX/Bybit files and pins the three
 * divergences that make this venue's mapping non-obvious — each one is a silent-wrong-state
 * risk, not a crash:
 *  - **margin mode is an ACCOUNT-level switch, not a per-symbol one.** On UTA the account
 *    carries an `accountLevel`, and isolated margin *is* the `isolated` level
 *    (`POST /api/v3/account/adjust-mode`). The port's `symbol` therefore has no venue analogue
 *    and is ignored; the call happens once per process. The switch is privileged and can be
 *    refused, so a failure is a **logged skip-with-reason plus a read-back** (`17` §3, the
 *    Bybit D1 precedent) — never a startup abort, because the mandate is still enforced one
 *    layer later by `marginMode: 'isolated'` on every submit.
 *  - **position mode is read before it is written**, because Bitget rejects the write while
 *    anything is open *even when the mode already matches* (OKX's `59000` lesson).
 *  - **leverage is per symbol and carries the margin mode**, with no `posSide` (one-way only).
 *
 * All three sit behind the applied-state cache, so a repeat with the same value must issue no
 * second call. Offline throughout: a fake client, a `vi.fn()` log spy, no clock, no network.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  type BitgetAccountSetupClient,
  createBitgetAccountSetup,
} from '../../../../../src/adapters/exchanges/bitget/account-setup.js'

interface Calls {
  settings: number
  leverage: unknown[]
  holdMode: unknown[]
  accountMode: unknown[]
}

function build(
  over: {
    /** `GET /api/v3/account/settings` reads, in order; the last one repeats (the read-back). */
    accountLevel?: string
    holdMode?: string
    /** Non-undefined → `adjustAccountMode` rejects with this value (the privileged refusal). */
    failAccountMode?: unknown
    /** Level reported by the read-back that follows a refused switch. */
    accountLevelAfter?: string
    log?: (m: string, meta?: Record<string, unknown>) => void
  } = {},
) {
  const calls: Calls = { settings: 0, leverage: [], holdMode: [], accountMode: [] }
  const client: BitgetAccountSetupClient = {
    getAccountSettings() {
      calls.settings += 1
      // The read-back (second read, after a refused switch) may report a different level.
      const level = calls.settings > 1 ? (over.accountLevelAfter ?? over.accountLevel) : over.accountLevel
      return Promise.resolve({ data: { accountLevel: level ?? 'isolated', holdMode: over.holdMode ?? 'one_way_mode' } })
    },
    adjustAccountMode(params) {
      calls.accountMode.push(params)
      return over.failAccountMode === undefined ? Promise.resolve({}) : Promise.reject(over.failAccountMode)
    },
    setHoldMode(params) {
      calls.holdMode.push(params)
      return Promise.resolve({})
    },
    setLeverage(params) {
      calls.leverage.push(params)
      return Promise.resolve({})
    },
  }
  const setup = createBitgetAccountSetup({
    client,
    resolveVenue: (s) => `${s}USDT`,
    ...(over.log ? { log: over.log } : {}),
  })
  return { setup, calls }
}

describe('createBitgetAccountSetup — leverage (11 §1)', () => {
  it('sets it per symbol, scoped by margin mode and category, with no posSide (one-way)', async () => {
    const { setup, calls } = build()
    await setup.setLeverage('BTC', 3)
    expect(calls.leverage).toEqual([
      { category: 'USDT-FUTURES', symbol: 'BTCUSDT', leverage: '3', marginMode: 'isolated' },
    ])
  })

  it('caches per symbol+value; a changed value re-applies', async () => {
    const { setup, calls } = build()
    await setup.setLeverage('BTC', 3)
    await setup.setLeverage('BTC', 3)
    await setup.setLeverage('BTC', 4)
    await setup.setLeverage('ETH', 3)
    expect(calls.leverage).toHaveLength(3)
  })

  it('does not cache a failed write — the next call retries it', async () => {
    let fail = true
    const attempts: unknown[] = []
    const client: BitgetAccountSetupClient = {
      getAccountSettings: () => Promise.resolve({ data: { accountLevel: 'isolated', holdMode: 'one_way_mode' } }),
      adjustAccountMode: () => Promise.resolve({}),
      setHoldMode: () => Promise.resolve({}),
      setLeverage: (params) => {
        attempts.push(params)
        return fail ? Promise.reject(new Error('boom')) : Promise.resolve({})
      },
    }
    const setup = createBitgetAccountSetup({ client, resolveVenue: (s) => s })
    await expect(setup.setLeverage('BTC', 3)).rejects.toThrow('boom')
    fail = false
    await setup.setLeverage('BTC', 3)
    expect(attempts).toHaveLength(2)
  })
})

describe('createBitgetAccountSetup — position mode (read before write)', () => {
  it('leaves an account already in one_way_mode alone (Bitget rejects the no-op write while open)', async () => {
    const { setup, calls } = build({ holdMode: 'one_way_mode' })
    await setup.setPositionMode('one_way')
    expect(calls.holdMode).toEqual([])
    expect(calls.settings).toBe(1) // read, then nothing
  })

  it('switches an account in hedge_mode to one_way_mode, once', async () => {
    const { setup, calls } = build({ holdMode: 'hedge_mode' })
    await setup.setPositionMode('one_way')
    await setup.setPositionMode('one_way') // cached: no second read, no second write
    expect(calls.holdMode).toEqual([{ holdMode: 'one_way_mode' }])
    expect(calls.settings).toBe(1)
  })
})

describe('createBitgetAccountSetup — margin mode (the account-level switch)', () => {
  it('writes nothing when the account already sits on the isolated level', async () => {
    const { setup, calls } = build({ accountLevel: 'isolated' })
    await setup.setMarginMode('BTC', 'isolated')
    expect(calls.accountMode).toEqual([])
    expect(calls.settings).toBe(1)
  })

  it('asks for the isolated level when the account sits on a cross level', async () => {
    const { setup, calls } = build({ accountLevel: 'advanced' })
    await setup.setMarginMode('BTC', 'isolated')
    // Account-level, so no symbol travels with the request.
    expect(calls.accountMode).toEqual([{ mode: 'isolated' }])
  })

  it('skips with a logged reason + read-back when the switch is refused (never a throw)', async () => {
    const log = vi.fn()
    const { setup } = build({
      accountLevel: 'basic',
      failAccountMode: new Error('40017 open positions prevent the switch'),
      accountLevelAfter: 'advanced', // the read-back sees what the account actually is now
      log,
    })
    await expect(setup.setMarginMode('BTC', 'isolated')).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(
      'bitget: account-level switch skipped — isolated margin rests on the per-order marginMode',
      // The read-back level, not the pre-switch one: a silently-ignored write must not pass
      // for a successful one, and the reason text carries the venue's refusal.
      expect.objectContaining({
        requested: 'isolated',
        accountLevel: 'advanced',
        reason: '40017 open positions prevent the switch',
      }),
    )
  })

  it('falls back to the pre-switch level when the read-back itself fails', async () => {
    const log = vi.fn()
    let reads = 0
    const client: BitgetAccountSetupClient = {
      getAccountSettings: () => {
        reads += 1
        // First read succeeds; the read-back after the refusal throws.
        return reads === 1
          ? Promise.resolve({ data: { accountLevel: 'basic', holdMode: 'one_way_mode' } })
          : Promise.reject(new Error('settings read failed'))
      },
      adjustAccountMode: () => Promise.reject(new Error('refused')),
      setHoldMode: () => Promise.resolve({}),
      setLeverage: () => Promise.resolve({}),
    }
    const setup = createBitgetAccountSetup({ client, resolveVenue: (s) => s, log })
    await expect(setup.setMarginMode('BTC', 'isolated')).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ accountLevel: 'basic' }))
  })

  it('is applied once per process, symbol ignored (the port symbol has no venue analogue)', async () => {
    const { setup, calls } = build({ accountLevel: 'advanced' })
    await setup.setMarginMode('BTC', 'isolated')
    await setup.setMarginMode('ETH', 'isolated')
    expect(calls.accountMode).toHaveLength(1)
    expect(calls.settings).toBe(1) // cached: the second call reads nothing either
  })

  it('tolerates a settings payload with no `data` (treated as an unknown level)', async () => {
    const calls: unknown[] = []
    const client: BitgetAccountSetupClient = {
      getAccountSettings: () => Promise.resolve({}),
      adjustAccountMode: (params) => {
        calls.push(params)
        return Promise.resolve({})
      },
      setHoldMode: () => Promise.resolve({}),
      setLeverage: () => Promise.resolve({}),
    }
    const setup = createBitgetAccountSetup({ client, resolveVenue: (s) => s })
    await setup.setMarginMode('BTC', 'isolated')
    expect(calls).toEqual([{ mode: 'isolated' }])
  })
})
