/**
 * Unit: Bybit account setup (`11` §1, task 0420 decision D1). The Binance sibling has no
 * dedicated file because its mapping is 1:1 with ccxt; Bybit's is not, so the three D1
 * divergences are pinned here: margin mode is **account-wide** (`symbol` ignored, one call
 * per process), position mode is scoped by settle coin, and leverage must send
 * `buyLeverage === sellLeverage`. Plus the "not modified" ret-codes, which are the venue's
 * way of saying "already applied" and must not fail startup after a restart.
 */

import { describe, expect, it } from 'vitest'
import {
  type BybitAccountSetupClient,
  createBybitAccountSetup,
} from '../../../../../src/adapters/exchanges/bybit/account-setup.js'

interface Calls {
  leverage: unknown[]
  margin: unknown[]
  position: unknown[]
}

function build(fail?: (op: keyof Calls) => unknown) {
  const calls: Calls = { leverage: [], margin: [], position: [] }
  const maybeThrow = (op: keyof Calls): Promise<unknown> => {
    const err = fail?.(op)
    return err === undefined ? Promise.resolve({ retCode: 0 }) : Promise.reject(err)
  }
  const client: BybitAccountSetupClient = {
    setLeverage(params) {
      calls.leverage.push(params)
      return maybeThrow('leverage')
    },
    setMarginMode(mode) {
      calls.margin.push(mode)
      return maybeThrow('margin')
    },
    switchPositionMode(params) {
      calls.position.push(params)
      return maybeThrow('position')
    },
  }
  const setup = createBybitAccountSetup({ client, resolveVenue: (s) => `${s}USDT` })
  return { setup, calls }
}

describe('createBybitAccountSetup (11 §1, D1)', () => {
  it('leverage: per symbol, buyLeverage === sellLeverage (required in one-way mode)', async () => {
    const { setup, calls } = build()
    await setup.setLeverage('BTC', 3)
    expect(calls.leverage).toEqual([{ category: 'linear', symbol: 'BTCUSDT', buyLeverage: '3', sellLeverage: '3' }])
  })

  it('leverage: cached per symbol+value, changed value re-applies', async () => {
    const { setup, calls } = build()
    await setup.setLeverage('BTC', 3)
    await setup.setLeverage('BTC', 3)
    await setup.setLeverage('BTC', 4)
    await setup.setLeverage('ETH', 3)
    expect(calls.leverage).toHaveLength(3)
  })

  it('margin mode: one account-wide ISOLATED_MARGIN call, symbol ignored, applied once', async () => {
    const { setup, calls } = build()
    await setup.setMarginMode('BTC', 'isolated')
    await setup.setMarginMode('ETH', 'isolated') // different symbol — still no second call
    expect(calls.margin).toEqual(['ISOLATED_MARGIN'])
  })

  it('position mode: one-way (mode 0) scoped by the USDT settle coin, applied once', async () => {
    const { setup, calls } = build()
    await setup.setPositionMode('one_way')
    await setup.setPositionMode('one_way')
    expect(calls.position).toEqual([{ category: 'linear', coin: 'USDT', mode: 0 }])
  })

  it('treats the "not modified" ret-codes as already-applied (survives a process restart)', async () => {
    const { setup } = build((op) => {
      if (op === 'margin') return { retCode: 110026, retMsg: 'Isolated margin mode is not modified' }
      if (op === 'position') return { retCode: 110025, retMsg: 'Position mode is not modified' }
      return { retCode: 110043, retMsg: 'Set leverage not modified' }
    })
    await expect(setup.setLeverage('BTC', 3)).resolves.toBeUndefined()
    await expect(setup.setMarginMode('BTC', 'isolated')).resolves.toBeUndefined()
    await expect(setup.setPositionMode('one_way')).resolves.toBeUndefined()
  })

  it('a real failure still throws (fail-loud before any trade)', async () => {
    const { setup } = build((op) => (op === 'margin' ? new Error('bybit {"retCode":110024}') : undefined))
    await expect(setup.setMarginMode('BTC', 'isolated')).rejects.toThrow(/110024/)
  })

  it('a failed write is NOT cached — the next call retries it', async () => {
    let fail = true
    const calls: string[] = []
    const client: BybitAccountSetupClient = {
      setLeverage: () => Promise.resolve({}),
      setMarginMode: (mode) => {
        calls.push(mode)
        return fail ? Promise.reject(new Error('boom')) : Promise.resolve({})
      },
      switchPositionMode: () => Promise.resolve({}),
    }
    const setup = createBybitAccountSetup({ client, resolveVenue: (s) => s })
    await expect(setup.setMarginMode('BTC', 'isolated')).rejects.toThrow('boom')
    fail = false
    await setup.setMarginMode('BTC', 'isolated')
    expect(calls).toHaveLength(2)
  })
})
