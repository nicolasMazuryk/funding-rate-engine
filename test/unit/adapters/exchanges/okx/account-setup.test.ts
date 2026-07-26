/**
 * Unit: OKX account setup (`11` §1). Mirrors the Bybit file, pinning the three divergences
 * that make this venue's mapping non-obvious:
 *  - **margin mode has no write of its own** — isolation is the per-order `tdMode`; what this
 *    method enforces is the `acctLv` precondition, and a refused account-level switch is a
 *    skip-with-reason (the Bybit D1 precedent), not a startup abort;
 *  - **position mode is read before it is written**, because OKX rejects the call with `59000`
 *    while anything is open *even when the mode already matches*;
 *  - **leverage carries `mgnMode`** and no `posSide` (net mode only), unlike Bybit's buy/sell
 *    pair.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createOkxAccountSetup,
  type OkxAccountSetupClient,
} from '../../../../../src/adapters/exchanges/okx/account-setup.js'

interface Calls {
  config: number
  leverage: unknown[]
  position: unknown[]
  accountLevel: unknown[]
}

function build(
  over: {
    acctLv?: string
    posMode?: string
    failAccountLevel?: unknown
    log?: (m: string, meta?: unknown) => void
  } = {},
) {
  const calls: Calls = { config: 0, leverage: [], position: [], accountLevel: [] }
  const client: OkxAccountSetupClient = {
    getAccountConfiguration() {
      calls.config += 1
      return Promise.resolve([{ acctLv: over.acctLv ?? '2', posMode: over.posMode ?? 'net_mode' }])
    },
    setLeverage(params) {
      calls.leverage.push(params)
      return Promise.resolve({})
    },
    setPositionMode(params) {
      calls.position.push(params)
      return Promise.resolve({})
    },
    setAccountMode(params) {
      calls.accountLevel.push(params)
      return over.failAccountLevel === undefined ? Promise.resolve({}) : Promise.reject(over.failAccountLevel)
    },
  }
  const setup = createOkxAccountSetup({
    client,
    resolveVenue: (s) => `${s}-USDT-SWAP`,
    ...(over.log ? { log: over.log as (m: string, meta?: Record<string, unknown>) => void } : {}),
  })
  return { setup, calls }
}

describe('createOkxAccountSetup — leverage (11 §1)', () => {
  it('sets it per instId, scoped by margin mode, with no posSide (net mode)', async () => {
    const { setup, calls } = build()
    await setup.setLeverage('BTC', 3)
    expect(calls.leverage).toEqual([{ instId: 'BTC-USDT-SWAP', lever: '3', mgnMode: 'isolated' }])
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
    const client: OkxAccountSetupClient = {
      getAccountConfiguration: () => Promise.resolve([{ acctLv: '2', posMode: 'net_mode' }]),
      setLeverage: (params) => {
        attempts.push(params)
        return fail ? Promise.reject(new Error('boom')) : Promise.resolve({})
      },
      setPositionMode: () => Promise.resolve({}),
      setAccountMode: () => Promise.resolve({}),
    }
    const setup = createOkxAccountSetup({ client, resolveVenue: (s) => s })
    await expect(setup.setLeverage('BTC', 3)).rejects.toThrow('boom')
    fail = false
    await setup.setLeverage('BTC', 3)
    expect(attempts).toHaveLength(2)
  })
})

describe('createOkxAccountSetup — position mode (read before write)', () => {
  it('leaves an account already in net_mode alone (OKX rejects the no-op write while open)', async () => {
    const { setup, calls } = build({ posMode: 'net_mode' })
    await setup.setPositionMode('one_way')
    expect(calls.position).toEqual([])
    expect(calls.config).toBe(1)
  })

  it('switches an account in long_short_mode to net_mode, once', async () => {
    const { setup, calls } = build({ posMode: 'long_short_mode' })
    await setup.setPositionMode('one_way')
    await setup.setPositionMode('one_way')
    expect(calls.position).toEqual([{ posMode: 'net_mode' }])
  })
})

describe('createOkxAccountSetup — margin mode (the acctLv precondition)', () => {
  it('writes nothing when the account already supports the per-order isolated tdMode', async () => {
    const { setup, calls } = build({ acctLv: '2' })
    await setup.setMarginMode('BTC', 'isolated')
    expect(calls.accountLevel).toEqual([])
  })

  it('asks for futures mode when the account sits on spot mode (no derivatives at all, 51010)', async () => {
    const { setup, calls } = build({ acctLv: '1' })
    await setup.setMarginMode('BTC', 'isolated')
    expect(calls.accountLevel).toEqual([{ acctLv: '2' }])
  })

  it('asks for futures mode when the account sits on portfolio margin (isolated unavailable there)', async () => {
    const { setup, calls } = build({ acctLv: '4' })
    await setup.setMarginMode('BTC', 'isolated')
    expect(calls.accountLevel).toEqual([{ acctLv: '2' }])
  })

  it('skips with a logged reason + read-back when the switch is account-privileged (D1 precedent)', async () => {
    const log = vi.fn()
    const { setup } = build({ acctLv: '3', failAccountLevel: new Error('50101 sub-account not permitted'), log })
    await expect(setup.setMarginMode('BTC', 'isolated')).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(
      'okx: account-level switch skipped — isolated margin rests on the per-order tdMode',
      expect.objectContaining({ requested: '2', acctLv: '3' }),
    )
  })

  it('is applied once per process, symbol ignored (the port symbol has no venue analogue)', async () => {
    const { setup, calls } = build({ acctLv: '4' })
    await setup.setMarginMode('BTC', 'isolated')
    await setup.setMarginMode('ETH', 'isolated')
    expect(calls.accountLevel).toHaveLength(1)
  })
})
