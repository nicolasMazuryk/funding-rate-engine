/**
 * Unit: KuCoin account setup (`11` §1). Mirrors the Bitget/OKX/Bybit files and pins the three
 * divergences that make this venue's mapping non-obvious — each one a silent-wrong-state risk
 * rather than a crash:
 *  - **margin mode is PER SYMBOL** (`updateMarginMode({ symbol, marginMode: 'ISOLATED' })`, upper
 *    case here), like Binance and unlike the three account-level venues. The mode is **read
 *    first** so a symbol already isolated is left alone, and a refused switch is a
 *    **logged skip-with-reason**, never a startup abort — the mandate is re-stated one layer later
 *    by `marginMode: 'ISOLATED'` on every submit (`./ws-orders.test.ts`).
 *  - **position mode is account-wide and NUMERIC** (`'0'` one-way, `'1'` hedge), read before it is
 *    written because the venue rejects the switch while anything is open (OKX's `59000` lesson).
 *  - **`setLeverage` issues no venue call at all** — the sharpest divergence of the five venues.
 *    KuCoin publishes only *cross*-margin leverage endpoints; isolated leverage is an **order
 *    parameter**, so setup records the value and the transport puts it on every submit. The
 *    assertion that matters is a negative one: the fake client must see **zero** calls.
 *
 * All of it sits behind the applied-state cache, so a repeat with the same value issues no second
 * call. Offline throughout: a fake client, a `vi.fn()` log spy, no clock, no network.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  createKucoinAccountSetup,
  type KucoinAccountSetupClient,
} from '../../../../../src/adapters/exchanges/kucoin/account-setup.js'

interface Calls {
  getMarginMode: unknown[]
  updateMarginMode: unknown[]
  getPositionMode: number
  updatePositionMode: unknown[]
}

function build(
  over: {
    /** What `getMarginMode` reports for every symbol. */
    marginMode?: string
    /** What `getPositionMode` reports (`'0'` one-way, `'1'` hedge; the venue also sends numbers). */
    positionMode?: string | number
    /** Non-undefined → `updateMarginMode` rejects with this value (the refusal path). */
    failMarginMode?: unknown
    log?: (m: string, meta?: Record<string, unknown>) => void
  } = {},
) {
  const calls: Calls = { getMarginMode: [], updateMarginMode: [], getPositionMode: 0, updatePositionMode: [] }
  const client: KucoinAccountSetupClient = {
    getMarginMode(params) {
      calls.getMarginMode.push(params)
      return Promise.resolve({ data: { marginMode: over.marginMode ?? 'ISOLATED' } })
    },
    updateMarginMode(params) {
      calls.updateMarginMode.push(params)
      return over.failMarginMode === undefined ? Promise.resolve({}) : Promise.reject(over.failMarginMode)
    },
    getPositionMode() {
      calls.getPositionMode += 1
      return Promise.resolve({ data: { positionMode: over.positionMode ?? '0' } })
    },
    updatePositionMode(params) {
      calls.updatePositionMode.push(params)
      return Promise.resolve({})
    },
  }
  const setup = createKucoinAccountSetup({
    client,
    resolveVenue: (s) => (s === 'BTC' ? 'XBTUSDTM' : `${s}USDTM`),
    ...(over.log ? { log: over.log } : {}),
  })
  return { setup, calls }
}

/** Every venue call the client can receive, summed — used to assert a total absence of traffic. */
const totalCalls = (c: Calls): number =>
  c.getMarginMode.length + c.updateMarginMode.length + c.getPositionMode + c.updatePositionMode.length

describe('createKucoinAccountSetup — leverage issues NO venue call (11 §1)', () => {
  it('records the value and touches the venue not at all', async () => {
    // There is no isolated-leverage endpoint on this venue — `./ws-orders.ts` puts the value on
    // every submit instead. A future edit that "fixes" this by calling the cross-margin endpoint
    // would silently set the wrong account's leverage; hence the zero-call assertion.
    const { setup, calls } = build()
    await setup.setLeverage('BTC', 3)
    expect(totalCalls(calls)).toBe(0)
  })

  it('reads the recorded value back per symbol (what the order transport threads onto the payload)', async () => {
    const { setup } = build()
    await setup.setLeverage('BTC', 3)
    await setup.setLeverage('ETH', 7)
    expect(setup.leverageFor('BTC')).toBe(3)
    expect(setup.leverageFor('ETH')).toBe(7)
    // Never set ⇒ undefined, which leaves the field off the order entirely.
    expect(setup.leverageFor('DOGE')).toBeUndefined()
  })

  it('a changed value overwrites the recorded one, still without a venue call', async () => {
    const { setup, calls } = build()
    await setup.setLeverage('BTC', 3)
    await setup.setLeverage('BTC', 4)
    expect(setup.leverageFor('BTC')).toBe(4)
    expect(totalCalls(calls)).toBe(0)
  })
})

describe('createKucoinAccountSetup — margin mode (per symbol, read before write)', () => {
  it('writes nothing when the symbol is already ISOLATED', async () => {
    const { setup, calls } = build({ marginMode: 'ISOLATED' })
    await setup.setMarginMode('BTC', 'isolated')
    expect(calls.getMarginMode).toEqual([{ symbol: 'XBTUSDTM' }]) // read, then nothing
    expect(calls.updateMarginMode).toEqual([])
  })

  it('switches a CROSS symbol to ISOLATED, scoped by the venue symbol', async () => {
    const { setup, calls } = build({ marginMode: 'CROSS' })
    await setup.setMarginMode('BTC', 'isolated')
    // Per symbol, so the symbol travels with the request — unlike the three account-level venues.
    expect(calls.updateMarginMode).toEqual([{ symbol: 'XBTUSDTM', marginMode: 'ISOLATED' }])
  })

  it('is applied per symbol, not once per process', async () => {
    const { setup, calls } = build({ marginMode: 'CROSS' })
    await setup.setMarginMode('BTC', 'isolated')
    await setup.setMarginMode('ETH', 'isolated')
    expect(calls.updateMarginMode).toEqual([
      { symbol: 'XBTUSDTM', marginMode: 'ISOLATED' },
      { symbol: 'ETHUSDTM', marginMode: 'ISOLATED' },
    ])
  })

  it('caches per symbol — a repeat reads nothing and writes nothing', async () => {
    const { setup, calls } = build({ marginMode: 'CROSS' })
    await setup.setMarginMode('BTC', 'isolated')
    await setup.setMarginMode('BTC', 'isolated')
    expect(calls.getMarginMode).toHaveLength(1)
    expect(calls.updateMarginMode).toHaveLength(1)
  })

  it('skips with a logged reason when the switch is refused (never a throw)', async () => {
    const log = vi.fn()
    const { setup } = build({
      marginMode: 'CROSS',
      failMarginMode: new Error('300002 open position prevents the switch'),
      log,
    })
    await expect(setup.setMarginMode('BTC', 'isolated')).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(
      'kucoin: margin-mode switch skipped — isolated margin rests on the per-order marginMode',
      expect.objectContaining({
        symbol: 'XBTUSDTM',
        current: 'CROSS',
        requested: 'ISOLATED',
        reason: '300002 open position prevents the switch',
      }),
    )
  })

  it('tolerates a payload with no `data` (treated as an unknown mode, so it asks for the switch)', async () => {
    const calls: unknown[] = []
    const client: KucoinAccountSetupClient = {
      getMarginMode: () => Promise.resolve({}),
      updateMarginMode: (params) => {
        calls.push(params)
        return Promise.resolve({})
      },
      getPositionMode: () => Promise.resolve({}),
      updatePositionMode: () => Promise.resolve({}),
    }
    const setup = createKucoinAccountSetup({ client, resolveVenue: (s) => s })
    await setup.setMarginMode('BTC', 'isolated')
    expect(calls).toEqual([{ symbol: 'BTC', marginMode: 'ISOLATED' }])
  })
})

describe('createKucoinAccountSetup — position mode (account-wide, numeric, read before write)', () => {
  it('leaves an account already in one-way mode alone (the venue rejects the no-op write while open)', async () => {
    const { setup, calls } = build({ positionMode: '0' })
    await setup.setPositionMode('one_way')
    expect(calls.getPositionMode).toBe(1)
    expect(calls.updatePositionMode).toEqual([])
  })

  it("switches a hedge-mode account to '0', once, with no symbol (it is account-wide)", async () => {
    const { setup, calls } = build({ positionMode: '1' })
    await setup.setPositionMode('one_way')
    await setup.setPositionMode('one_way') // cached: no second read, no second write
    expect(calls.updatePositionMode).toEqual([{ positionMode: '0' }])
    expect(calls.getPositionMode).toBe(1)
  })

  it('compares the mode as a string, so a numeric 0 off the wire still counts as one-way', async () => {
    const { setup, calls } = build({ positionMode: 0 })
    await setup.setPositionMode('one_way')
    expect(calls.updatePositionMode).toEqual([])
  })
})
