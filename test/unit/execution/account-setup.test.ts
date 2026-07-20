/**
 * Unit: account setup (`11` §1, `00_globals` §4). Two layers:
 *   - the venue-specific cached ccxt wrapper (`binance/account-setup.ts`) — a repeat call
 *     with the same value is a no-op (applied-state cache); a benign `-4046` margin
 *     "no need to change" counts as applied;
 *   - the venue-neutral orchestration (`execution/account-setup.ts`) — position mode once,
 *     then per-symbol margin + leverage; a throw marks that symbol untradable (hard reject).
 * Both run offline against fakes.
 */

import { describe, expect, it } from 'vitest'
import {
  type BinanceAccountSetupClient,
  createBinanceAccountSetup,
} from '../../../src/adapters/exchanges/binance/account-setup.js'
import type { AccountSetupExchange } from '../../../src/execution/account-setup.js'
import { runAccountSetup } from '../../../src/execution/account-setup.js'

/** A ccxt fake recording every account-setup call it receives. */
function fakeClient(overrides: Partial<BinanceAccountSetupClient> = {}): {
  client: BinanceAccountSetupClient
  calls: string[]
} {
  const calls: string[] = []
  const client: BinanceAccountSetupClient = {
    setLeverage(leverage, symbol) {
      calls.push(`setLeverage:${symbol}:${leverage}`)
      return Promise.resolve({})
    },
    setMarginMode(mode, symbol) {
      calls.push(`setMarginMode:${symbol}:${mode}`)
      return Promise.resolve({})
    },
    setPositionMode(hedged) {
      calls.push(`setPositionMode:${hedged}`)
      return Promise.resolve({})
    },
    ...overrides,
  }
  return { client, calls }
}

describe('binance account setup — applied-state cache', () => {
  it('applies each op once; a repeat with the same value is a no-op', async () => {
    const { client, calls } = fakeClient()
    const setup = createBinanceAccountSetup({ client, resolveVenue: (s) => `${s}USDT` })

    await setup.setPositionMode('one_way')
    await setup.setPositionMode('one_way') // cached — no second venue call
    await setup.setMarginMode('BTC', 'isolated')
    await setup.setMarginMode('BTC', 'isolated') // cached
    await setup.setLeverage('BTC', 5)
    await setup.setLeverage('BTC', 5) // cached

    expect(calls).toEqual(['setPositionMode:false', 'setMarginMode:BTCUSDT:isolated', 'setLeverage:BTCUSDT:5'])
  })

  it('re-applies leverage when the value changes', async () => {
    const { client, calls } = fakeClient()
    const setup = createBinanceAccountSetup({ client, resolveVenue: (s) => `${s}USDT` })

    await setup.setLeverage('BTC', 5)
    await setup.setLeverage('BTC', 10)

    expect(calls).toEqual(['setLeverage:BTCUSDT:5', 'setLeverage:BTCUSDT:10'])
  })

  it('passes one-way as hedged:false and applies the effective leverage number verbatim', async () => {
    const { client, calls } = fakeClient()
    const setup = createBinanceAccountSetup({ client, resolveVenue: (s) => `${s}USDT` })

    await setup.setPositionMode('one_way')
    await setup.setLeverage('ETH', 4)

    expect(calls).toEqual(['setPositionMode:false', 'setLeverage:ETHUSDT:4'])
  })

  it('treats a benign -4046 margin "no need to change" as applied (not a throw)', async () => {
    const { client } = fakeClient({
      setMarginMode() {
        return Promise.reject(new Error('binance {"code":-4046,"msg":"No need to change margin type."}'))
      },
    })
    const setup = createBinanceAccountSetup({ client, resolveVenue: (s) => `${s}USDT` })

    await expect(setup.setMarginMode('BTC', 'isolated')).resolves.toBeUndefined()
  })

  it('propagates a non-benign setLeverage failure to the caller', async () => {
    const { client } = fakeClient({
      setLeverage() {
        return Promise.reject(new Error('binance {"code":-4028,"msg":"Leverage is too large."}'))
      },
    })
    const setup = createBinanceAccountSetup({ client, resolveVenue: (s) => `${s}USDT` })

    await expect(setup.setLeverage('BTC', 999)).rejects.toThrow(/-4028/)
  })
})

describe('runAccountSetup — venue-neutral orchestration + readiness', () => {
  /** A minimal exchange fake over the three account-setup port methods. */
  function fakeExchange(overrides: Partial<AccountSetupExchange> = {}): {
    exchange: AccountSetupExchange
    calls: string[]
  } {
    const calls: string[] = []
    const exchange: AccountSetupExchange = {
      setPositionMode(mode) {
        calls.push(`setPositionMode:${mode}`)
        return Promise.resolve()
      },
      setMarginMode(symbol, mode) {
        calls.push(`setMarginMode:${symbol}:${mode}`)
        return Promise.resolve()
      },
      setLeverage(symbol, leverage) {
        calls.push(`setLeverage:${symbol}:${leverage}`)
        return Promise.resolve()
      },
      ...overrides,
    }
    return { exchange, calls }
  }

  it('sets position mode once, then margin + leverage per symbol; all ready', async () => {
    const { exchange, calls } = fakeExchange()
    const result = await runAccountSetup(exchange, ['BTC', 'ETH'], (s) => (s === 'BTC' ? 5 : 4))

    expect(calls).toEqual([
      'setPositionMode:one_way',
      'setMarginMode:BTC:isolated',
      'setLeverage:BTC:5',
      'setMarginMode:ETH:isolated',
      'setLeverage:ETH:4',
    ])
    expect(result.isReady('BTC')).toBe(true)
    expect(result.isReady('ETH')).toBe(true)
  })

  it('marks only the failing symbol untradable (hard reject); others stay ready', async () => {
    const { exchange } = fakeExchange({
      setLeverage(symbol) {
        if (symbol === 'BTC') return Promise.reject(new Error('leverage rejected'))
        return Promise.resolve()
      },
    })
    const result = await runAccountSetup(exchange, ['BTC', 'ETH'], () => 5)

    expect(result.isReady('BTC')).toBe(false)
    expect(result.isReady('ETH')).toBe(true)
  })

  it('a setPositionMode failure makes no symbol tradable (account-wide)', async () => {
    const { exchange } = fakeExchange({
      setPositionMode() {
        return Promise.reject(new Error('position mode rejected'))
      },
    })
    const result = await runAccountSetup(exchange, ['BTC', 'ETH'], () => 5)

    expect(result.isReady('BTC')).toBe(false)
    expect(result.isReady('ETH')).toBe(false)
  })
})
